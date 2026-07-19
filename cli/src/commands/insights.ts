import { join } from "node:path";
import type { CommandEvent, Config, Turn } from "../core/types.js";
import { collect, type CollectOptions } from "../core/collect.js";
import { collectCodex } from "../core/collect-codex.js";
import { parseTranscriptFile, type ParsedTranscript } from "../core/parse.js";
import { parseCodexFile } from "../core/parse-codex.js";
import { compileIgnorePatterns } from "../core/filter.js";
import {
  buildCostRows,
  buildRecommendations,
  computeMetrics,
  renderInsightsHtml,
  sumAutopilotAvoided,
  type CostRow,
  type InsightsMetrics,
  type Recommendation,
} from "../core/insights.js";
import { hookInstalled } from "../core/settings.js";
import { DEFAULT_USER_SCOPE_DAYS } from "../core/scope.js";
import { loadConfig, projectKey, resolveTargets } from "../config.js";
import { adoptionFromEvents } from "./stats.js";
import { gradientDir } from "../core/manifest.js";
import { safeWriteFile } from "../core/safeFs.js";

export interface InsightsReport {
  label: string;
  metrics: InsightsMetrics;
  avoided: number;
  recommendations: Recommendation[];
  costs: CostRow[];
  capped: boolean;
}

export const INSIGHTS_MAX_FILES = 2_000;
export const INSIGHTS_MAX_TURNS = 100_000;
export const INSIGHTS_MAX_ANALYSIS_TURNS = 10_000;

function addMetrics(total: InsightsMetrics, next: InsightsMetrics): void {
  for (const key of Object.keys(total) as Array<keyof InsightsMetrics>) total[key] += next[key];
}

export interface InsightsDeps {
  collectFn?: (options: CollectOptions) => Promise<string[]>;
  collectCodexFn?: (options: CollectOptions) => Promise<string[]>;
  parseFn?: (path: string) => Promise<ParsedTranscript>;
  parseCodexFn?: (path: string) => Promise<Turn[]>;
  config?: Config;
}

export async function insights(
  opts: { projectDir: string; user?: boolean; home?: string; now?: number },
  deps: InsightsDeps = {},
): Promise<InsightsReport> {
  const config = deps.config ?? (await loadConfig(opts.home));
  const targets = resolveTargets(config);
  const collectFn = deps.collectFn ?? collect;
  const collectCodexFn = deps.collectCodexFn ?? collectCodex;
  const parseFn = deps.parseFn ?? parseTranscriptFile;
  const parseCodexFn = deps.parseCodexFn ?? parseCodexFile;
  const days = config.userScopeDays ?? DEFAULT_USER_SCOPE_DAYS;
  const scope: CollectOptions = opts.user
    ? { scope: "all", sinceDays: days, home: opts.home }
    : { scope: "project", projectPath: opts.projectDir, home: opts.home };
  const label = opts.user ? `user scope · last ${days}d` : "project scope · all history";
  const claudeFiles = targets.includes("claude-code") ? await collectFn(scope) : [];
  const codexFiles = targets.includes("codex") ? await collectCodexFn(scope) : [];
  const files: Array<{ path: string; assistant: "claude-code" | "codex" }> = [];
  for (let index = 0; files.length < INSIGHTS_MAX_FILES && (index < claudeFiles.length || index < codexFiles.length); index++) {
    if (index < claudeFiles.length && files.length < INSIGHTS_MAX_FILES) {
      files.push({ path: claudeFiles[index], assistant: "claude-code" });
    }
    if (index < codexFiles.length && files.length < INSIGHTS_MAX_FILES) {
      files.push({ path: codexFiles[index], assistant: "codex" });
    }
  }

  const ignore = compileIgnorePatterns(config.ignorePatterns);
  const metrics = computeMetrics([], [], ignore);
  const analysisTurns: Turn[] = [];
  const events: CommandEvent[] = [];
  let processedTurns = 0;
  let analysisComplete = true;
  let capped = claudeFiles.length + codexFiles.length > files.length;
  const cutoff = opts.user ? (opts.now ?? Date.now()) - days * 86_400_000 : undefined;
  const inCutoff = (ts: string): boolean => {
    if (cutoff === undefined) return true;
    const timestamp = Date.parse(ts);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  };
  // Shared INSIGHTS_MAX_ANALYSIS_TURNS budget for both branches below.
  const pushAnalysis = (turns: Turn[]): void => {
    if (!analysisComplete) return;
    const remaining = INSIGHTS_MAX_ANALYSIS_TURNS - analysisTurns.length;
    if (turns.length <= remaining) analysisTurns.push(...turns);
    else {
      analysisTurns.push(...turns.slice(0, Math.max(0, remaining)));
      analysisComplete = false;
      capped = true;
    }
  };

  for (const file of files) {
    if (processedTurns >= INSIGHTS_MAX_TURNS) { capped = true; break; }
    const remaining = INSIGHTS_MAX_TURNS - processedTurns;

    if (file.assistant === "codex") {
      // Codex parsing is untouched — its transcripts carry no command-tag events.
      const raw = await parseCodexFn(file.path);
      const scopedTurns = raw.filter(turn => inCutoff(turn.ts));
      const parsedTurns = scopedTurns.slice(0, remaining);
      if (scopedTurns.length > parsedTurns.length) capped = true;
      processedTurns += parsedTurns.length;
      addMetrics(metrics, computeMetrics(parsedTurns, [], ignore));
      pushAnalysis(parsedTurns);
      continue;
    }

    const raw = await parseFn(file.path);
    const scopedTurns = raw.turns.filter(turn => inCutoff(turn.ts));
    const scopedEvents = raw.events.filter(event => inCutoff(event.ts));
    const parsedTurns = scopedTurns.slice(0, remaining);
    if (scopedTurns.length > parsedTurns.length) capped = true;
    processedTurns += parsedTurns.length;
    events.push(...scopedEvents);
    addMetrics(metrics, computeMetrics(parsedTurns, scopedEvents, ignore));
    pushAnalysis(parsedTurns);
  }

  const costs = buildCostRows(analysisTurns, ignore);
  const avoided = await sumAutopilotAvoided(opts.home);
  const recallInstalled = await hookInstalled(opts.projectDir, "UserPromptSubmit", "gradient recall");
  let unusedArtifacts: string[] = [];
  if (!opts.user && analysisComplete && !capped) {
    try {
      unusedArtifacts = (await adoptionFromEvents(opts.projectDir, events, { home: opts.home, now: opts.now }))
        .filter(artifact => artifact.suggestRemoval)
        .map(artifact => artifact.name);
    } catch {
      // Corrupt or unavailable adoption data must not hide the behavior report.
    }
  }

  return {
    label,
    metrics,
    costs,
    avoided,
    capped,
    recommendations: buildRecommendations(metrics, {
      autopilotMode: config.autopilotProjects?.[projectKey(opts.projectDir)],
      avoided,
      recallInstalled,
      unusedArtifacts,
    }),
  };
}

export async function writeInsightsHtml(projectDir: string, report: InsightsReport): Promise<string> {
  const path = join(gradientDir(projectDir), "insights.html");
  await safeWriteFile(projectDir, path, renderInsightsHtml(report), { mode: 0o600 });
  return path;
}
