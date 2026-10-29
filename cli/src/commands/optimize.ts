import { homedir } from "node:os";
import { join } from "node:path";
import type { Assistant, Config, Suggestion } from "../core/types.js";
import { scan, type ScanDeps } from "./scan.js";
import { loadSuggestions } from "./apply.js";
import { applySuggestionTransactional, reverseBookkeeping } from "../core/apply.js";
import { loadInstructions } from "../core/instructions.js";
import { loadSurface } from "../core/surface.js";
import { findStaleRefs } from "../core/staleness.js";
import { buildFindings, findingActionability, findingPreview, type Change, type Finding } from "../core/findings.js";
import { applyChange, baseFor } from "../core/apply-change.js";
import {
  beginRun,
  pruneRuns,
  saveResult,
  undoRun,
  withLock,
  withFileTransaction,
  type BookkeepingRecord,
  type Run,
  type RunResult,
} from "../core/run.js";
import { addDismissal, dismissFinding, findingEvidenceHash, isDismissed, isFindingDismissed, loadDismissed, loadFindingDismissals } from "../core/dismiss.js";
import { FEATURE_PURPOSE, type FeatureName } from "./features.js";
import { featureStatus } from "./report.js";
import { loadManifest } from "../core/manifest.js";
import { hookInstalled } from "../core/settings.js";
import { continuityStatus } from "./continuity.js";
import { loadConfig, projectCacheDir, resolveCheapModel } from "../config.js";
import { resolveScanScope } from "../core/scope.js";
import { gradientCommand, isGradientHookFor } from "../core/hookBinary.js";
import { ensureTargets, type TargetAsker } from "../core/targets.js";
import { renderPage } from "../core/page.js";
import { insights } from "./insights.js";
import { safeReadFile, safeWriteFile } from "../core/safeFs.js";

/**
 * The one verb.
 *
 * Mine both assistants' history, read the configuration they actually load,
 * and propose one ranked list of changes: skills to create, retire, or repair;
 * instructions the repository has outgrown; the bridge that makes one setup
 * serve both. Local, deterministic, and offline — which is what lets it run in
 * a hook and on a schedule.
 */

export interface OptimizeOptions {
  target?: string | boolean;
  user?: boolean;
  all?: boolean;
  since?: number;
  limit?: number;
  maxPrompts?: number;
  /** Ids to apply. Empty means propose only. */
  apply?: string[];
  /** Ids to remember as denied, so they stop coming back. */
  deny?: string[];
  /** Accepted for compatibility and no longer needed: the page is written on
   *  every run. Scheduled commands and older docs still pass it, and the
   *  parser rejects flags it does not know, so removing it would break them. */
  page?: boolean;
  home?: string;
  now?: number;
}

export interface OptimizeResult {
  targets: Assistant[];
  findings: Finding[];
  /** Set when the run wrote anything; names the run for `--undo`. */
  runId?: string;
  applied: RunResult["applied"];
  skipped: RunResult["skipped"];
  /** The checkup page for this run; a path to open. Always written. */
  pagePath?: string;
  /** What is running in the background, and what each one that is not would
   *  do. Carried on the result so the terminal and `--json` agree: most people
   *  reach optimize through the skill, which reads JSON and never sees the
   *  terminal block. */
  features?: { name: string; on: boolean; purpose: string; supported?: boolean; detail?: string }[];
  warnings?: string[];
  coverage?: { label: string; prompts: number; limited: boolean };
}

export interface OptimizeDeps extends ScanDeps {
  ask?: TargetAsker;
  /** Skips mining; used by tests and by callers that already have suggestions. */
  suggestions?: Suggestion[];
  insightsFn?: typeof insights;
}

/**
 * The mined half of a run.
 *
 * `--apply` deliberately does not mine. It is a follow-up to a run that just
 * happened, and re-reading hundreds of transcripts to rebuild findings the user
 * is already looking at would make approving a one-line change the slowest
 * thing gradient does. The cheap half — instructions, installed skills,
 * staleness — is re-read either way, so a file that moved is still caught by
 * the apply preconditions.
 */
async function mine(
  projectDir: string,
  opts: OptimizeOptions,
  config: Config,
  log: (message: string) => void,
  deps: OptimizeDeps,
): Promise<Suggestion[]> {
  if (deps.suggestions) return deps.suggestions;
  if ((opts.apply ?? []).length > 0) return loadSuggestions(projectDir, { home: opts.home });
  const resolved = resolveScanScope(
    { user: !!opts.user, all: !!opts.all, since: opts.since },
    config,
  );
  log(resolved.label);
  return scan(
    {
      scope: resolved.scope,
      projectPath: projectDir,
      sinceDays: resolved.sinceDays,
      limit: opts.limit,
      maxPrompts: opts.maxPrompts,
      home: opts.home,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    },
    { ...deps, log, config },
  );
}

/**
 * Apply one finding.
 *
 * Two executors, deliberately. A mined workflow goes through `applySuggestion`,
 * which already knows how to emit for both assistants, install a hook, and
 * record a removable manifest entry — reimplementing that as a generic change
 * would be a rewrite of the most safety-critical code in the repository.
 * Everything else is a `Change` against a file gradient does not own, and goes
 * through `applyChange`, which snapshots and checks preconditions.
 */
async function applyFinding(
  finding: Finding,
  run: Run,
  projectDir: string,
  config: Config,
  targets: Assistant[],
  home: string,
): Promise<{ paths: string[]; wrote: RunResult["wrote"]; bookkeeping?: BookkeepingRecord[] }> {
  const action = findingActionability(finding);
  if (!action.actionable) throw new Error(action.reason);
  if (finding.suggestion) {
    return applySuggestionTransactional(finding.suggestion, projectDir, run, {
      targets, cheapModel: resolveCheapModel(config), home, hookBinary: gradientCommand(),
    });
  }
  const transaction = await withFileTransaction(run,
    finding.changes.map(change => ({ path: change.path, base: baseFor(change, projectDir, home) })),
    async () => {
      for (const change of finding.changes) {
        await applyChange({ run, projectDir, base: baseFor(change, projectDir, home) }, change);
      }
    });
  return { paths: Object.keys(transaction.wrote), wrote: transaction.wrote };
}

/**
 * The order findings are applied in, so gradient's own writes do not invalidate
 * each other's preconditions.
 *
 * Every line-bearing change carries the exact line it was proposed for. Adding
 * the `@AGENTS.md` bridge to CLAUDE.md pushes everything below it down two
 * lines, so a stale line on line 3 of that same file is then refused as "not
 * the line this was proposed for". That is a correct refusal of a stale line
 * number, but it half-applied the very command the CLI prints for itself —
 * `gradient optimize --apply <id>,<id>` — and it is what "accept all" on the
 * checkup page sends.
 *
 * Two rules fix it without relaxing a single precondition: within a file, later
 * lines go first, because deleting line 10 cannot move line 3; and anything
 * that inserts goes last, because an insert moves everything after it.
 */
export function applyOrder(findings: Finding[]): Finding[] {
  const inserts = (finding: Finding): boolean =>
    finding.suggestion !== undefined ||
    finding.changes.some(change => change.op === "prepend-import" || change.op === "splice-line");
  const lastLine = (finding: Finding): number =>
    finding.changes.reduce((max, change) => Math.max(max, change.line ?? 0), 0);

  // Rank first, sort second: the ranking the user read is the tiebreaker, so
  // findings that cannot collide with each other keep the order they were shown.
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) =>
      Number(inserts(a.finding)) - Number(inserts(b.finding)) ||
      lastLine(b.finding) - lastLine(a.finding) ||
      a.index - b.index)
    .map(entry => entry.finding);
}

export async function optimize(
  projectDir: string,
  opts: OptimizeOptions = {},
  deps: OptimizeDeps = {},
): Promise<OptimizeResult> {
  const home = opts.home ?? homedir();
  const log = deps.log ?? (() => {});

  const { targets } = await ensureTargets(
    { ...(opts.target !== undefined ? { flag: opts.target } : {}), home },
    deps.ask ? { ask: deps.ask } : {},
  );

  const config = { ...(await loadConfig(home)), targets };
  const suggestions = await mine(projectDir, opts, config, log, deps);

  const instructions = await loadInstructions(projectDir, targets, { home });
  const surface = await loadSurface(projectDir, targets, { home });
  const warnings = [...(instructions.warnings ?? []), ...(surface.warnings ?? [])];
  warnings.push(...instructions.unreadable.map(path => `Instruction file could not be inspected: ${path}`));
  const stale = await findStaleRefs(instructions.lines, projectDir);
  // Reuse this bounded read for usage evidence and the page. Unknown or capped
  // history yields no retirement advice, never fabricated zero-use evidence.
  const scope = resolveScanScope({ user: opts.user, all: opts.all, since: opts.since }, config);
  const observed = await (deps.insightsFn ?? insights)({ projectDir, home, now: opts.now, scope }, { config })
    .catch(() => { warnings.push("History metrics were unavailable; usage could not be assessed."); return undefined; });
  if (observed?.capped) warnings.push("History inspection reached a safety limit; usage observations are incomplete.");
  const coverage = observed ? { label: observed.label, prompts: observed.metrics.prompts, limited: observed.capped } : undefined;
  const features = await featureStatus(projectDir, config, home)
    .then(rows => rows.map(row => ({ ...row, purpose: FEATURE_PURPOSE[row.name as FeatureName] ?? "" })))
    .catch(() => undefined);
  const pendingSuggestions = await unsatisfiedSuggestions(suggestions, projectDir, home, features);
  const all = buildFindings({
    projectDir, targets, instructions, surface, stale, suggestions: pendingSuggestions,
    adoption: observed && !observed.capped ? observed.adoption : [],
  });
  const dismissed = await loadDismissed(projectDir);
  const findingDismissals = await loadFindingDismissals(projectDir, home);
  const reviewed = await loadLastCheckup(projectDir, { home });
  let findings = all.filter(finding =>
    !isFindingDismissed(finding, findingDismissals) &&
    !(finding.suggestion && isDismissed(finding.suggestion, dismissed)));
  const requested = opts.apply ?? [];
  const matches = (finding: Finding, id: string): boolean =>
    finding.id === id || finding.suggestion?.id === id || finding.suggestion?.name === id;
  const wanted = findings.filter(finding => requested.some(id => matches(finding, id)));
  const skipped: RunResult["skipped"] = requested
    .filter(id => !findings.some(finding => matches(finding, id)))
    .map(id => ({ id, reason: "no current finding has this id; it may be resolved or dismissed — rerun to see the list" }));

  const execute = async (): Promise<OptimizeResult> => {
    const denied = new Set<string>();
    for (const id of opts.deny ?? []) {
      const finding = all.find(candidate => matches(candidate, id));
      if (!finding) { skipped.push({ id, reason: "no current finding has this id to dismiss" }); continue; }
      if (finding.suggestion) await addDismissal(projectDir, finding.suggestion);
      else await dismissFinding(projectDir, finding, home);
      denied.add(finding.id);
    }
    findings = findings.filter(finding => !denied.has(finding.id));
    const run = await beginRun({ home, ...(opts.now !== undefined ? { now: new Date(opts.now) } : {}) });
    const applied: RunResult["applied"] = [];
    const wrote: RunResult["wrote"] = {};
    const bookkeeping: BookkeepingRecord[] = [];
    for (const finding of applyOrder(wanted)) {
      if (denied.has(finding.id)) { skipped.push({ id: finding.id, reason: "dismissed in this request" }); continue; }
      const prior = reviewed?.findings.find(entry => entry.id === finding.id);
      if (prior?.evidenceHash && prior.evidenceHash !== findingEvidenceHash(finding)) {
        skipped.push({ id: finding.id, reason: "the evidence or proposed change changed since the last checkup; review the new page before applying" });
        continue;
      }
      try {
        const outcome = await applyFinding(finding, run, projectDir, config, targets, home);
        if (outcome.paths.length === 0) {
          skipped.push({ id: finding.id, reason: "no files changed; the proposed state is already present" });
          continue;
        }
        applied.push({ id: finding.id, title: finding.title, paths: outcome.paths });
        Object.assign(wrote, outcome.wrote);
        bookkeeping.push(...(outcome.bookkeeping ?? []));
      } catch (error) {
        skipped.push({ id: finding.id, reason: (error as Error).message });
      }
      // Retain a complete undo record as soon as each finding finishes.
      await saveResult(run, {
        runId: run.id, startedAt: run.startedAt, applied, skipped, wrote,
        ...(bookkeeping.length ? { bookkeeping } : {}),
      });
    }
    const appliedIds = new Set(applied.map(entry => entry.id));
    findings = findings.filter(finding => !appliedIds.has(finding.id));
    const pagePath = join(run.dir, "report.html");
    await safeWriteFile(home, pagePath, renderPage({
      runId: run.id, projectDir, targets, findings, warnings, coverage,
      ...(observed ? { metrics: observed.metrics } : {}),
      contextCost: { skills: surface.skills.length, chars: surface.contextChars },
    }), { mode: 0o600 });
    await saveLastCheckup(projectDir, home, {
      checkedAt: run.startedAt, pagePath, targets,
      findings: findings.map(finding => ({
        id: finding.id, family: finding.family, title: finding.title, severity: finding.severity,
        actionable: findingActionability(finding).actionable,
        evidenceHash: findingEvidenceHash(finding),
      })),
    });
    await pruneRuns({ home });
    return { targets, findings, ...(applied.length ? { runId: run.id } : {}), applied, skipped, pagePath,
      ...(features ? { features } : {}), warnings, ...(coverage ? { coverage } : {}) };
  };
  return wanted.length || opts.deny?.length
    ? withLock(execute, { home, ...(opts.now !== undefined ? { now: opts.now } : {}) }) : execute();
}

async function unsatisfiedSuggestions(
  suggestions: Suggestion[], projectDir: string, home: string, features: OptimizeResult["features"],
): Promise<Suggestion[]> {
  const installed = new Set((await loadManifest(projectDir).catch(() => [])).map(entry => entry.suggestionId));
  const continuity = await continuityStatus(projectDir, { home }).catch(() => ({ checkpoint: false, recap: false }));
  const pending: Suggestion[] = [];
  for (const suggestion of suggestions) {
    if (installed.has(suggestion.id)) continue;
    const payload = suggestion.payload;
    if (payload.type === "loop" && features?.some(feature => feature.name === "autopilot" && feature.on)) continue;
    if (payload.type === "hook") {
      if (payload.subcommand === "checkpoint" && continuity.checkpoint) continue;
      if (payload.subcommand === "recap" && continuity.recap) continue;
      if (!["checkpoint", "recap"].includes(payload.subcommand ?? "") && await hookInstalled(projectDir, payload.event,
        command => payload.command !== undefined ? command === payload.command : isGradientHookFor(command, payload.subcommand ?? ""),
        { matcher: payload.matcher })) continue;
    }
    pending.push(suggestion);
  }
  return pending;
}

export interface CheckupSummary {
  checkedAt: string;
  pagePath: string;
  targets: Assistant[];
  findings: Array<{ id: string; family: string; title: string; severity: "high" | "medium" | "low"; actionable: boolean; evidenceHash?: string }>;
}
const CHECKUP_MAX_BYTES = 1_000_000;
async function saveLastCheckup(projectDir: string, home: string, summary: CheckupSummary): Promise<void> {
  const data = JSON.stringify(summary);
  if (Buffer.byteLength(data) > CHECKUP_MAX_BYTES) throw new Error("checkup summary exceeds safety limit");
  await safeWriteFile(home, join(projectCacheDir(projectDir, home), "last-checkup.json"), data, { mode: 0o600 });
}
export async function loadLastCheckup(projectDir: string, opts: { home?: string } = {}): Promise<CheckupSummary | null> {
  const home = opts.home ?? homedir();
  try {
    const value = JSON.parse(await safeReadFile(home, join(projectCacheDir(projectDir, home), "last-checkup.json"), { maxBytes: CHECKUP_MAX_BYTES }));
    if (!value || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) ||
      typeof value.pagePath !== "string" || !Array.isArray(value.targets) ||
      !value.targets.every((target: unknown) => target === "claude-code" || target === "codex") ||
      !Array.isArray(value.findings) || value.findings.length > 2_000 ||
      !value.findings.every((finding: any) => finding && /^[a-f0-9]{12}$/.test(finding.id) &&
        typeof finding.title === "string" && finding.title.length <= 2_000 && !/[\r\n\u001b]/.test(finding.title) &&
        typeof finding.family === "string" && ["high", "medium", "low"].includes(finding.severity) && typeof finding.actionable === "boolean" &&
        (finding.evidenceHash === undefined || /^[a-f0-9]{64}$/.test(finding.evidenceHash)))) return null;
    return value as CheckupSummary;
  } catch { return null; }
}

export async function undo(runId: string, opts: { home?: string } = {}): Promise<{
  restored: string[];
  conflicted: string[];
}> {
  return withLock(() => undoRun(runId, {
    ...opts, reverseBookkeeping: records => reverseBookkeeping(records, opts.home),
  }), opts);
}

/** The machine-readable form the skill reads. Findings only — never the raw
 *  transcript text they were mined from. */
export function optimizeJson(result: OptimizeResult): string {
  return JSON.stringify({
    targets: result.targets,
    ...(result.runId ? { runId: result.runId } : {}),
    // The page is written on every run, so the machine-readable output has to
    // say where — an agent handed --json cannot otherwise point the user at it.
    ...(result.pagePath ? { pagePath: result.pagePath } : {}),
    ...(result.features ? { features: result.features } : {}),
    warnings: result.warnings ?? [],
    ...(result.coverage ? { coverage: result.coverage } : {}),
    findings: result.findings.map(finding => ({
      id: finding.id,
      family: finding.family,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      evidence: finding.evidence,
      targets: finding.targets,
      deterministic: finding.deterministic,
      commandBearing: finding.commandBearing,
      ...findingActionability(finding),
      ...(findingPreview(finding) ? { preview: findingPreview(finding) } : {}),
      changes: finding.changes.map((change: Change) => ({
        op: change.op,
        path: change.path,
        ...(change.line !== undefined ? { line: change.line } : {}),
        ...(change.before !== undefined ? { before: change.before } : {}),
        ...(change.after !== undefined ? { after: change.after } : {}),
      })),
    })),
    applied: result.applied,
    skipped: result.skipped,
  }, null, 2);
}
