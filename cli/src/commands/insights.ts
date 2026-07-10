import type { Config, Turn } from "../core/types.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collect, type CollectOptions } from "../core/collect.js";
import { collectCodex } from "../core/collect-codex.js";
import { parseFile } from "../core/parse.js";
import { parseCodexFile } from "../core/parse-codex.js";
import { compileIgnorePatterns } from "../core/filter.js";
import {
  buildRecommendations,
  buildCostRows,
  computeMetrics,
  renderInsightsHtml,
  sumAutopilotAvoided,
  type InsightsMetrics,
  type Recommendation,
  type CostRow,
} from "../core/insights.js";
import { hookInstalled } from "../core/settings.js";
import { DEFAULT_USER_SCOPE_DAYS } from "../core/scope.js";
import { loadConfig, resolveTargets } from "../config.js";
import { adoptionFromTurns } from "./stats.js";
import { gradientDir } from "../core/manifest.js";

export interface InsightsReport {
  label: string;
  metrics: InsightsMetrics;
  avoided: number;
  recommendations: Recommendation[];
  costs: CostRow[];
}

export interface InsightsDeps {
  collectFn?: (options: CollectOptions) => Promise<string[]>;
  collectCodexFn?: (options: CollectOptions) => Promise<string[]>;
  parseFn?: (path: string) => Promise<Turn[]>;
  parseCodexFn?: (path: string) => Promise<Turn[]>;
  config?: Config;
}

export async function insights(
  opts: { projectDir: string; user?: boolean; home?: string },
  deps: InsightsDeps = {},
): Promise<InsightsReport> {
  const config = deps.config ?? (await loadConfig(opts.home));
  const collectFn = deps.collectFn ?? collect;
  const collectCodexFn = deps.collectCodexFn ?? collectCodex;
  const parseFn = deps.parseFn ?? parseFile;
  const parseCodexFn = deps.parseCodexFn ?? parseCodexFile;
  const targets = resolveTargets(config);
  const days = config.userScopeDays ?? DEFAULT_USER_SCOPE_DAYS;
  const scope: CollectOptions = opts.user
    ? { scope: "all", sinceDays: days, home: opts.home }
    : { scope: "project", projectPath: opts.projectDir, home: opts.home };
  const label = opts.user ? `user scope · last ${days}d` : "project scope · all history";

  const turns: Turn[] = [];
  if (targets.includes("claude-code")) {
    for (const file of await collectFn(scope)) turns.push(...(await parseFn(file)));
  }
  if (targets.includes("codex")) {
    for (const file of await collectCodexFn(scope)) turns.push(...(await parseCodexFn(file)));
  }
  const metrics = computeMetrics(turns, compileIgnorePatterns(config.ignorePatterns));
  const costs = buildCostRows(turns, compileIgnorePatterns(config.ignorePatterns));
  const avoided = await sumAutopilotAvoided(opts.home);
  const recallInstalled = await hookInstalled(opts.projectDir, "UserPromptSubmit", "gradient recall");

  let unusedArtifacts: string[] = [];
  if (!opts.user) {
    try {
      unusedArtifacts = (await adoptionFromTurns(opts.projectDir, turns))
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
    costs,
    recommendations: buildRecommendations(metrics, {
      autopilotMode: config.autopilot,
      avoided,
      recallInstalled,
      unusedArtifacts,
    }),
  };
}

export async function writeInsightsHtml(projectDir: string, report: InsightsReport): Promise<string> {
  const dir = gradientDir(projectDir);
  const path = join(dir, "insights.html");
  await mkdir(dir, { recursive: true });
  await writeFile(path, renderInsightsHtml(report));
  return path;
}
