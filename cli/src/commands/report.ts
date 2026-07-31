import type { AdoptionRow } from "../core/adoption.js";
import type { Suggestion } from "../core/types.js";
import { isDismissed, loadDismissed } from "../core/dismiss.js";
import { loadManifest } from "../core/manifest.js";
import { loadConfig, projectKey } from "../config.js";
import { insights, type InsightsReport } from "./insights.js";
import { loadSuggestions } from "./apply.js";
import { boardShow } from "./board.js";
import { continuityStatus } from "./continuity.js";
import { isMeasured } from "../core/classify.js";

/** How many pending suggestions the bare report shows before deferring to scan. */
export const REPORT_MAX_SUGGESTIONS = 3;

export interface FeatureStatus {
  name: string;
  on: boolean;
  detail?: string;
}

export interface Report {
  insights: InsightsReport;
  adoption: AdoptionRow[];
  pending: Suggestion[];
  features: FeatureStatus[];
  /** Rendered board digest, or null when this is not a git repository. */
  board: string | null;
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
  };
}

async function featureStatus(
  projectDir: string,
  config: { autopilotProjects?: Record<string, string>; boardProjects?: string[]; scanOnSessionStart?: boolean },
  home?: string,
): Promise<FeatureStatus[]> {
  const continuity = await continuityStatus(projectDir, { home }).catch(() => ({ checkpoint: false, recap: false }));
  const mode = config.autopilotProjects?.[projectKey(projectDir)];
  return [
    {
      name: "continuity",
      on: continuity.checkpoint || continuity.recap,
      ...(continuity.checkpoint !== continuity.recap
        ? { detail: `${continuity.checkpoint ? "checkpoint" : "recap"} only` }
        : {}),
    },
    {
      name: "autopilot",
      on: mode === "nudge" || mode === "full",
      ...(mode && mode !== "off" ? { detail: mode } : {}),
    },
    { name: "board", on: (config.boardProjects ?? []).length > 0 },
    { name: "session-scan", on: config.scanOnSessionStart === true },
  ];
}
