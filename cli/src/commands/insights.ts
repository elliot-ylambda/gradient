import type { Config, Turn } from "../core/types.js";
import { join } from "node:path";
import { collect, type CollectOptions } from "../core/collect.js";
import { parseFile } from "../core/parse.js";
import { compileIgnorePatterns } from "../core/filter.js";
import {
  buildRecommendations,
  computeMetrics,
  renderInsightsHtml,
  sumAutopilotAvoided,
  type InsightsMetrics,
  type Recommendation,
} from "../core/insights.js";
import { hookInstalled } from "../core/settings.js";
import { DEFAULT_USER_SCOPE_DAYS } from "../core/scope.js";
import { loadConfig, projectKey } from "../config.js";
import { adoptionFromTurns } from "./stats.js";
import { gradientDir } from "../core/manifest.js";
import { safeWriteFile } from "../core/safeFs.js";

export interface InsightsReport {
  label: string;
  metrics: InsightsMetrics;
  avoided: number;
  recommendations: Recommendation[];
  capped: boolean;
}

export const INSIGHTS_MAX_FILES = 2_000;
export const INSIGHTS_MAX_TURNS = 100_000;
export const INSIGHTS_MAX_ADOPTION_TURNS = 10_000;

function addMetrics(total: InsightsMetrics, next: InsightsMetrics): void {
  for (const key of Object.keys(total) as Array<keyof InsightsMetrics>) total[key] += next[key];
}

export interface InsightsDeps {
  collectFn?: (options: CollectOptions) => Promise<string[]>;
  parseFn?: (path: string) => Promise<Turn[]>;
  config?: Config;
}

export async function insights(
  opts: { projectDir: string; user?: boolean; home?: string; now?: number },
  deps: InsightsDeps = {},
): Promise<InsightsReport> {
  const config = deps.config ?? (await loadConfig(opts.home));
  const collectFn = deps.collectFn ?? collect;
  const parseFn = deps.parseFn ?? parseFile;
  const days = config.userScopeDays ?? DEFAULT_USER_SCOPE_DAYS;
  const scope: CollectOptions = opts.user
    ? { scope: "all", sinceDays: days, home: opts.home }
    : { scope: "project", projectPath: opts.projectDir, home: opts.home };
  const label = opts.user ? `user scope · last ${days}d` : "project scope · all history";

  const metrics = computeMetrics([], compileIgnorePatterns(config.ignorePatterns));
  const adoptionTurns: Turn[] = [];
  let processedTurns = 0;
  let adoptionComplete = true;
  let capped = false;
  const cutoff = opts.user ? (opts.now ?? Date.now()) - days * 86_400_000 : undefined;
  const collected = await collectFn(scope);
  const files = collected.slice(0, INSIGHTS_MAX_FILES);
  if (collected.length > files.length) capped = true;
  const ignore = compileIgnorePatterns(config.ignorePatterns);
  for (const file of files) {
    if (processedTurns >= INSIGHTS_MAX_TURNS) { capped = true; break; }
    const raw = await parseFn(file);
    const scoped = (cutoff === undefined ? raw : raw.filter(turn => {
      const ts = Date.parse(turn.ts);
      return Number.isFinite(ts) && ts >= cutoff;
    }));
    const remaining = INSIGHTS_MAX_TURNS - processedTurns;
    const parsed = scoped.slice(0, remaining);
    if (scoped.length > parsed.length) capped = true;
    processedTurns += parsed.length;
    addMetrics(metrics, computeMetrics(parsed, ignore));
    if (!opts.user && adoptionComplete) {
      const adoptionRemaining = INSIGHTS_MAX_ADOPTION_TURNS - adoptionTurns.length;
      if (parsed.length <= adoptionRemaining) adoptionTurns.push(...parsed);
      else adoptionComplete = false;
    }
  }
  const avoided = await sumAutopilotAvoided(opts.home);
  const recallInstalled = await hookInstalled(opts.projectDir, "UserPromptSubmit", "gradient recall");

  let unusedArtifacts: string[] = [];
  if (!opts.user && adoptionComplete && !capped) {
    try {
      unusedArtifacts = (await adoptionFromTurns(opts.projectDir, adoptionTurns, { home: opts.home, now: opts.now }))
        .filter(artifact => artifact.suggestRemoval)
        .map(artifact => artifact.name);
    } catch {
      // Corrupt or unavailable Phase B data must not hide the behavior report.
    }
  }

  return {
    label,
    metrics,
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
  const dir = gradientDir(projectDir);
  const path = join(dir, "insights.html");
  await safeWriteFile(projectDir, path, renderInsightsHtml(report), { mode: 0o600 });
  return path;
}
