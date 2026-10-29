import type { AdoptionRow } from "../core/adoption.js";
import type { Config, Suggestion } from "../core/types.js";
import { isDismissed, loadDismissed } from "../core/dismiss.js";
import { loadManifest } from "../core/manifest.js";
import { loadConfig, projectKey, supportsClaudeHooks } from "../config.js";
import { insights, type InsightsReport } from "./insights.js";
import { loadSuggestions } from "./apply.js";
import { boardShow, DIGEST_SUB, REFRESH_SUB } from "./board.js";
import { continuityStatus } from "./continuity.js";
import { autopilotStatus, type AutopilotStatus } from "./autopilot.js";
import { isMeasured } from "../core/classify.js";
import { resolveBoardRoot } from "../core/board.js";
import { hookInstalled } from "../core/settings.js";
import { isGradientHookFor } from "../core/hookBinary.js";
import { FEATURES, SESSION_END_SUB, SESSION_START_SUB } from "./features.js";

/** How many pending suggestions the bare report shows before deferring to scan. */
export const REPORT_MAX_SUGGESTIONS = 3;

export interface FeatureStatus {
  name: string;
  on: boolean;
  detail?: string;
  supported?: boolean;
}

export interface Report {
  insights: InsightsReport;
  adoption: AdoptionRow[];
  pending: Suggestion[];
  features: FeatureStatus[];
  /** Rendered board digest, or null when this is not a git repository. */
  board: string | null;
  /** Mode, budget, clamps, and recent decisions — but only when autopilot is on
   *  here. It is the one feature whose state is too specific for a one-line
   *  row, and the reason it no longer needs a verb of its own. */
  autopilot: AutopilotStatus | null;
}

export interface ReportDeps {
  home?: string;
  now?: number;
  selfSessionId?: string;
  insightsFn?: typeof insights;
  boardShowFn?: typeof boardShow;
  loadSuggestionsFn?: typeof loadSuggestions;
}

/**
 * Everything the bare `gradient` invocation answers, gathered once.
 *
 * This replaced five separate verbs — `insights`, `stats`, `mirror`, `list`, and
 * `board` — that each read the same transcripts to answer one part of the same
 * question. Each is still available as a hidden alias for one release, but there
 * is no longer a reason to know which one to type.
 */
export async function buildReport(projectDir: string, deps: ReportDeps = {}): Promise<Report> {
  const report = await (deps.insightsFn ?? insights)({
    projectDir,
    home: deps.home,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  const [manifest, dismissed, suggestions, config] = await Promise.all([
    loadManifest(projectDir).catch(() => []),
    loadDismissed(projectDir).catch(() => []),
    (deps.loadSuggestionsFn ?? loadSuggestions)(projectDir, { home: deps.home }).catch(() => []),
    loadConfig(deps.home).catch(() => ({})),
  ]);

  const applied = new Set(manifest.map(entry => entry.suggestionId));
  const pending = suggestions
    .filter(suggestion => !applied.has(suggestion.id) && !isDismissed(suggestion, dismissed))
    // Measured first, matching scan: a suggestion counted from tool events is
    // evidence, and one read out of prompt text is an interpretation of it.
    .sort((left, right) =>
      Number(isMeasured(right)) - Number(isMeasured(left)) ||
      right.evidence.count - left.evidence.count ||
      left.name.localeCompare(right.name))
    .slice(0, REPORT_MAX_SUGGESTIONS);

  return {
    insights: report,
    adoption: report.adoption,
    pending,
    features: await featureStatus(projectDir, config, deps.home),
    board: await (deps.boardShowFn ?? boardShow)(projectDir, {
      home: deps.home,
      ...(deps.selfSessionId ? { selfSessionId: deps.selfSessionId } : {}),
    }).catch(() => null),
    autopilot: await autopilotDetail(projectDir, deps.home),
  };
}

/** Autopilot's own status, but only when it is on for this project. Off, it is
 *  one word in the feature row and a block would be noise. */
async function autopilotDetail(projectDir: string, home?: string): Promise<AutopilotStatus | null> {
  try {
    const status = await autopilotStatus(projectDir, { home });
    return status.mode === "off" && status.effectiveMode === "off" ? null : status;
  } catch {
    return null;
  }
}

export async function featureStatus(
  projectDir: string,
  config: Config,
  home?: string,
): Promise<FeatureStatus[]> {
  if (!supportsClaudeHooks(config)) {
    return FEATURES.map(name => ({ name, on: false, supported: false, detail: "Gradient currently uses Claude Code hooks only" }));
  }
  const continuity = await continuityStatus(projectDir, { home }).catch(() => ({ checkpoint: false, recap: false }));
  const mode = config.autopilotProjects?.[projectKey(projectDir)];
  const root = await resolveBoardRoot(projectDir).catch(() => null);
  const hasHook = (event: string, sub: string): Promise<boolean> =>
    hookInstalled(projectDir, event, cmd => isGradientHookFor(cmd, sub));
  const [respond, digest, refresh, start, end] = await Promise.all([
    hasHook("Stop", "respond"), hasHook("SessionStart", DIGEST_SUB),
    hasHook("UserPromptSubmit", REFRESH_SUB), hasHook("SessionStart", SESSION_START_SUB),
    hasHook("SessionEnd", SESSION_END_SUB),
  ]);
  return [
    {
      name: "continuity",
      on: continuity.checkpoint && continuity.recap,
      ...(continuity.checkpoint !== continuity.recap
        ? { detail: `${continuity.checkpoint ? "checkpoint" : "recap"} only` }
        : {}),
    },
    {
      name: "autopilot",
      on: mode === "nudge" && respond,
      ...(mode === "nudge" ? { detail: respond ? mode : "hook missing; enable again to repair" } : {}),
    },
    { name: "board", on: !!root && (config.boardProjects ?? []).includes(root) && digest && refresh },
    // Named for the verb that toggles it. This row said "session-scan", which
    // is the config's name for the behaviour and not a feature any command
    // accepts: `gradient on session-scan` answers "unknown feature". The
    // report is where people read the state, so it has to print the word they
    // can act on.
    { name: "optimize", on: (config.optimizeProjects ?? []).includes(projectKey(projectDir)) && start && end,
      ...(config.scanOnSessionStart === true && !config.optimizeProjects?.includes(projectKey(projectDir))
        ? { detail: "enable again for this project; legacy global consent is inactive" } : {}) },
  ];
}
