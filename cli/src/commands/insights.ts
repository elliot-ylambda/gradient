import type { Config, Turn } from "../core/types.js";
import { collect, type CollectOptions } from "../core/collect.js";
import { parseFile } from "../core/parse.js";
import { compileIgnorePatterns } from "../core/filter.js";
import {
  buildRecommendations,
  computeMetrics,
  sumAutopilotAvoided,
  type InsightsMetrics,
  type Recommendation,
} from "../core/insights.js";
import { hookInstalled } from "../core/settings.js";
import { DEFAULT_USER_SCOPE_DAYS } from "../core/scope.js";
import { loadConfig } from "../config.js";
import { adoptionFromTurns } from "./stats.js";

export interface InsightsReport {
  label: string;
  metrics: InsightsMetrics;
  avoided: number;
  recommendations: Recommendation[];
}

export interface InsightsDeps {
  collectFn?: (options: CollectOptions) => Promise<string[]>;
  parseFn?: (path: string) => Promise<Turn[]>;
  config?: Config;
}

export async function insights(
  opts: { projectDir: string; user?: boolean; home?: string },
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

  const turns: Turn[] = [];
  for (const file of await collectFn(scope)) turns.push(...(await parseFn(file)));
  const metrics = computeMetrics(turns, compileIgnorePatterns(config.ignorePatterns));
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
    recommendations: buildRecommendations(metrics, {
      autopilotMode: config.autopilot,
      avoided,
      recallInstalled,
      unusedArtifacts,
    }),
  };
}
