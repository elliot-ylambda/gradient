import { homedir } from "node:os";
import { join } from "node:path";
import type { Assistant, Config, Suggestion } from "../core/types.js";
import type { InsightsMetrics } from "../core/insights.js";
import { scan, type ScanDeps } from "./scan.js";
import { loadSuggestions, saveSuggestions } from "./apply.js";
import { applySuggestion } from "../core/apply.js";
import { loadInstructions } from "../core/instructions.js";
import { loadSurface } from "../core/surface.js";
import { findStaleRefs } from "../core/staleness.js";
import { buildFindings, type Change, type Finding } from "../core/findings.js";
import { applyChange, autoApplicable, baseFor } from "../core/apply-change.js";
import {
  beginRun,
  pruneRuns,
  saveResult,
  undoRun,
  withLock,
  type Run,
  type RunResult,
} from "../core/run.js";
import { addDismissal, isDismissed, loadDismissed } from "../core/dismiss.js";
import { FEATURE_PURPOSE, type FeatureName } from "./features.js";
import { featureStatus } from "./report.js";
import { adoptionFromEvents } from "../core/adoption.js";
import { loadConfig, resolveCheapModel, resolveTargets } from "../config.js";
import { resolveScanScope } from "../core/scope.js";
import { gradientCommand } from "../core/hookBinary.js";
import { ensureTargets, type TargetAsker } from "../core/targets.js";
import { renderPage } from "../core/page.js";
import { insights } from "./insights.js";
import { safeWriteFile } from "../core/safeFs.js";

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
  /** Apply every deterministic, unattended-safe finding without asking. */
  auto?: boolean;
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
  features?: { name: string; on: boolean; purpose: string }[];
}

export interface OptimizeDeps extends ScanDeps {
  ask?: TargetAsker;
  /** Skips mining; used by tests and by callers that already have suggestions. */
  suggestions?: Suggestion[];
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
): Promise<{ paths: string[]; wrote: Record<string, string> }> {
  const paths: string[] = [];
  const wrote: Record<string, string> = {};

  if (finding.suggestion) {
    const result = await applySuggestion(finding.suggestion, projectDir, {
      targets,
      cheapModel: resolveCheapModel(config),
      home,
      hookBinary: gradientCommand(),
    });
    for (const write of result.writes) paths.push(write.path);
    if (result.failures.length > 0 && result.writes.length === 0) {
      throw new Error(result.failures.map(failure => `${failure.target}: ${failure.error}`).join("; "));
    }
    return { paths, wrote };
  }

  for (const change of finding.changes) {
    const base = baseFor(change, projectDir, home);
    const outcome = await applyChange({ run, projectDir, base }, change);
    paths.push(outcome.path);
    wrote[outcome.path] = outcome.sha256;
  }
  return { paths, wrote };
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

/** Whether `--auto` may take this finding without a person seeing it. */
export function autoEligible(finding: Finding): { ok: boolean; reason?: string } {
  if (!finding.deterministic) return { ok: false, reason: "needs judgment" };
  if (finding.commandBearing) return { ok: false, reason: "proposes text containing a command" };
  // A mined workflow creates a gradient-owned artifact and is reversible, but
  // it is also the family most likely to be wrong, so it stays opt-in.
  if (finding.suggestion) return { ok: false, reason: "installs a new artifact" };
  if (finding.changes.length === 0) return { ok: false, reason: "has nothing to apply on its own" };
  for (const change of finding.changes) {
    const verdict = autoApplicable(change);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
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
  const stale = await findStaleRefs(instructions.lines, projectDir);
  const adoption = await adoptionFromEvents(projectDir, [], {
    home,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    suggestions,
  });

  const all = buildFindings({
    projectDir, targets, instructions, surface, stale, suggestions, adoption,
  });

  // A denial sticks: a finding the user has already said no to must not come
  // back every run, or a scheduled optimizer becomes noise.
  const dismissed = await loadDismissed(projectDir);
  const findings = all.filter(finding =>
    !(finding.suggestion && isDismissed(finding.suggestion, dismissed)));

  for (const id of opts.deny ?? []) {
    const finding = findings.find(candidate => candidate.id === id);
    if (finding?.suggestion) await addDismissal(projectDir, finding.suggestion);
  }

  const requested = opts.apply ?? [];
  // A finding id, or — for a mined workflow — the suggestion's own id or name.
  // The report lists pending suggestions by name, so the name has to work.
  const matches = (finding: Finding): boolean =>
    requested.includes(finding.id) ||
    (finding.suggestion !== undefined &&
      (requested.includes(finding.suggestion.id) || requested.includes(finding.suggestion.name)));

  const wanted = opts.auto
    ? findings.filter(finding => autoEligible(finding).ok)
    : findings.filter(matches);

  // Findings are recomputed every run, so an id from an older run only matches
  // while the thing it described is still true. Saying nothing here would look
  // like a successful apply that changed nothing — the user has to be told the
  // finding is gone, not left to guess.
  const unmatched = requested
    .filter(id => !findings.some(finding =>
      finding.id === id ||
      (finding.suggestion !== undefined && (finding.suggestion.id === id || finding.suggestion.name === id))))
    .map(id => ({ id, reason: "no current finding has this id; it may have been fixed already — rerun to see the list" }));

  // The page describes a run, so a read-only run gets a run directory too —
  // its own id is what the user quotes back and what --undo would name.
  //
  // Written on every run, not only when asked. The findings are a ranked list
  // with ids and evidence; the page is where that list is actually reviewable,
  // and a flag you have to know about is a flag most people never pass. Runs
  // are pruned to the newest ten, so this costs one bounded file per run.
  // One run per invocation, shared by the page and by anything applied. Writing
  // the page in its own run would give the reader a run id that `--undo` does
  // not name, and would burn two of the ten retained runs per apply.
  // Read once and shared by both return paths. Best-effort: a config that will
  // not load must not stop the findings from being reported.
  const features = await featureStatus(projectDir, config, home)
    .then(rows => rows.map(row => ({
      name: row.name,
      on: row.on,
      purpose: FEATURE_PURPOSE[row.name as FeatureName] ?? "",
    })))
    .catch(() => undefined);

  const writePage = async (run: Run): Promise<string> => {
    const path = join(run.dir, "report.html");
    await safeWriteFile(home, path, renderPage({
      runId: run.id,
      projectDir,
      targets,
      findings,
      ...(await pageMetrics(projectDir, home)),
      contextCost: { skills: surface.skills.length, chars: surface.contextChars },
    }), { mode: 0o600 });
    return path;
  };

  if (wanted.length === 0) {
    const run = await beginRun({ home, ...(opts.now !== undefined ? { now: new Date(opts.now) } : {}) });
    const pagePath = await writePage(run);
    await pruneRuns({ home });
    return { targets, findings, applied: [], skipped: unmatched, pagePath, ...(features ? { features } : {}) };
  }

  return withLock(async () => {
    const run = await beginRun({ home, ...(opts.now !== undefined ? { now: new Date(opts.now) } : {}) });
    const pagePath = await writePage(run);
    const applied: RunResult["applied"] = [];
    const skipped: RunResult["skipped"] = [...unmatched];
    const wrote: Record<string, string> = {};

    for (const finding of applyOrder(wanted)) {
      if (opts.auto) {
        const verdict = autoEligible(finding);
        if (!verdict.ok) {
          skipped.push({ id: finding.id, reason: verdict.reason ?? "not eligible" });
          continue;
        }
      }
      try {
        const outcome = await applyFinding(finding, run, projectDir, config, targets, home);
        applied.push({ id: finding.id, title: finding.title, paths: outcome.paths });
        Object.assign(wrote, outcome.wrote);
      } catch (error) {
        skipped.push({ id: finding.id, reason: (error as Error).message });
      }
    }

    // The suggestion cache has to agree with what was installed, or a later
    // `gradient remove` looks for an artifact that is not in it.
    if (applied.length > 0) await saveSuggestions(projectDir, await loadSuggestions(projectDir, { home }), home);

    await saveResult(run, { runId: run.id, startedAt: run.startedAt, applied, skipped, wrote });
    await pruneRuns({ home });
    return { targets, findings, runId: run.id, applied, skipped, pagePath, ...(features ? { features } : {}) };
  }, { home, ...(opts.now !== undefined ? { now: opts.now } : {}) });
}

export async function undo(runId: string, opts: { home?: string } = {}): Promise<{
  restored: string[];
  conflicted: string[];
}> {
  return withLock(() => undoRun(runId, opts), opts);
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
      autoEligible: autoEligible(finding).ok,
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

/** Behaviour metrics for the page header. Best-effort: the page is worth
 *  showing without them, and this is the one part of a run that reads the whole
 *  corpus a second time. */
async function pageMetrics(projectDir: string, home: string): Promise<{ metrics?: InsightsMetrics }> {
  try {
    const report = await insights({ projectDir, home });
    return { metrics: report.metrics };
  } catch {
    return {};
  }
}
