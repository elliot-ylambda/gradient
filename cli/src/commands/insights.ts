import { join } from "node:path";
import type { Config, ToolEvent, Turn } from "../core/types.js";
import { collect, type CollectOptions } from "../core/collect.js";
import { collectCodex } from "../core/collect-codex.js";
import { parseFile, parseToolEventsFile } from "../core/parse.js";
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
  type ToolActivityMetrics,
} from "../core/insights.js";
import { hookInstalled } from "../core/settings.js";
import { DEFAULT_USER_SCOPE_DAYS } from "../core/scope.js";
import { loadConfig, projectKey, resolveTargets } from "../config.js";
import { adoptionFromTurns } from "./stats.js";
import { gradientDir } from "../core/manifest.js";
import { safeWriteFile } from "../core/safeFs.js";
import { loadInstructionAudit, type InstructionTally } from "../core/audit.js";
import { failureLoops as mineFailureLoops, rituals as mineRituals } from "../core/toolmine.js";

export interface InsightsReport {
  label: string;
  metrics: InsightsMetrics;
  avoided: number;
  recommendations: Recommendation[];
  costs: CostRow[];
  capped: boolean;
  toolActivity: ToolActivityMetrics;
  instructionEffectiveness?: InstructionTally[];
}

export const INSIGHTS_MAX_FILES = 2_000;
export const INSIGHTS_MAX_TURNS = 100_000;
export const INSIGHTS_MAX_ANALYSIS_TURNS = 10_000;
export const INSIGHTS_MAX_TOOL_EVENTS = 20_000;

function addMetrics(total: InsightsMetrics, next: InsightsMetrics): void {
  for (const key of Object.keys(total) as Array<keyof InsightsMetrics>) total[key] += next[key];
}

export interface InsightsDeps {
  collectFn?: (options: CollectOptions) => Promise<string[]>;
  collectCodexFn?: (options: CollectOptions) => Promise<string[]>;
  parseFn?: (path: string) => Promise<Turn[]>;
  parseToolEventsFn?: (path: string) => Promise<{ events: ToolEvent[]; dropped: number }>;
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
  const parseFn = deps.parseFn ?? parseFile;
  const parseToolEventsFn = deps.parseToolEventsFn ?? (deps.parseFn ? undefined : parseToolEventsFile);
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
  const metrics = computeMetrics([], ignore);
  const analysisTurns: Turn[] = [];
  let toolEvents: ToolEvent[] = [];
  let toolEventsDropped = 0;
  let processedTurns = 0;
  let analysisComplete = true;
  let capped = claudeFiles.length + codexFiles.length > files.length;
  const cutoff = opts.user ? (opts.now ?? Date.now()) - days * 86_400_000 : undefined;

  for (const file of files) {
    if (processedTurns >= INSIGHTS_MAX_TURNS) { capped = true; break; }
    const raw = file.assistant === "codex" ? await parseCodexFn(file.path) : await parseFn(file.path);
    const scoped = cutoff === undefined ? raw : raw.filter(turn => {
      const timestamp = Date.parse(turn.ts);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    const remaining = INSIGHTS_MAX_TURNS - processedTurns;
    const parsed = scoped.slice(0, remaining);
    if (scoped.length > parsed.length) capped = true;
    processedTurns += parsed.length;
    addMetrics(metrics, computeMetrics(parsed, ignore));
    if (file.assistant === "claude-code" && config.mineToolEvents !== false && parseToolEventsFn) {
      const parsedEvents = await parseToolEventsFn(file.path);
      const scopedEvents = cutoff === undefined ? parsedEvents.events : parsedEvents.events.filter(event => {
        const timestamp = Date.parse(event.ts);
        return Number.isFinite(timestamp) && timestamp >= cutoff;
      });
      toolEventsDropped += parsedEvents.dropped;
      toolEvents.push(...scopedEvents);
      if (toolEvents.length > INSIGHTS_MAX_TOOL_EVENTS) {
        toolEvents.sort((left, right) => left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0);
        toolEventsDropped += toolEvents.length - INSIGHTS_MAX_TOOL_EVENTS;
        toolEvents = toolEvents.slice(0, INSIGHTS_MAX_TOOL_EVENTS);
      }
    }
    if (analysisComplete) {
      const analysisRemaining = INSIGHTS_MAX_ANALYSIS_TURNS - analysisTurns.length;
      if (parsed.length <= analysisRemaining) analysisTurns.push(...parsed);
      else {
        analysisTurns.push(...parsed.slice(0, Math.max(0, analysisRemaining)));
        analysisComplete = false;
        capped = true;
      }
    }
  }

  const costs = buildCostRows(analysisTurns, ignore);
  const toolActivity: ToolActivityMetrics = {
    failureLoops: mineFailureLoops(toolEvents).length,
    postEditRituals: mineRituals(toolEvents).length,
  };
  if (toolEventsDropped > 0) capped = true;
  const avoided = await sumAutopilotAvoided(opts.home);
  const recallInstalled = await hookInstalled(opts.projectDir, "UserPromptSubmit", "gradient recall");
  const auditSnapshot = opts.user ? null : await loadInstructionAudit(opts.projectDir, opts.home);
  const instructionEffectiveness = auditSnapshot?.tallies
    .filter(tally => tally.restatements + tally.violations > 0)
    .sort((left, right) =>
      (right.restatements + right.violations) - (left.restatements + left.violations) ||
      left.text.localeCompare(right.text))
    .slice(0, 15);
  let unusedArtifacts: string[] = [];
  if (!opts.user && analysisComplete && !capped) {
    try {
      unusedArtifacts = (await adoptionFromTurns(opts.projectDir, analysisTurns, { home: opts.home, now: opts.now }))
        .filter(artifact => artifact.suggestRemoval)
        .map(artifact => artifact.name);
    } catch {
      // Corrupt or unavailable adoption data must not hide the behavior report.
    }
  }

  const recommendations = buildRecommendations(metrics, {
    autopilotMode: config.autopilotProjects?.[projectKey(opts.projectDir)],
    avoided,
    recallInstalled,
    unusedArtifacts,
  });
  if (toolActivity.postEditRituals > 0) recommendations.unshift({
    metric: "post-edit-rituals",
    line: `${toolActivity.postEditRituals} post-edit ritual(s) detected — run gradient scan, then gradient review`,
  });
  if (toolActivity.failureLoops > 0) recommendations.unshift({
    metric: "failure-loops",
    line: `${toolActivity.failureLoops} recurring in-session command failure loop(s) — run gradient scan, then gradient review`,
  });

  return {
    label,
    metrics,
    costs,
    avoided,
    capped,
    toolActivity,
    ...(instructionEffectiveness?.length ? { instructionEffectiveness } : {}),
    recommendations,
  };
}

export async function writeInsightsHtml(projectDir: string, report: InsightsReport): Promise<string> {
  const path = join(gradientDir(projectDir), "insights.html");
  await safeWriteFile(projectDir, path, renderInsightsHtml(report), { mode: 0o600 });
  return path;
}
