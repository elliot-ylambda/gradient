import { readdir } from "node:fs/promises";
import type { Turn, AutopilotMode } from "./types.js";
import { classifyPrompt } from "./filter.js";
import { extractPasteKey } from "./paste.js";
import { cleanupStale, loadState, stateDir } from "./state.js";

const NUDGE_RE = /^(continue|go on|keep going|next|what'?s next|proceed|yes|y|ok|okay|do it|go|sure|yep|good|great|perfect|lgtm|looks good|approved?|ship it|sounds good)[.!?]*$/i;
const TAG_RE = /<command-name>\/?([\w:-]+)<\/command-name>/i;

export function isNudgeText(text: string): boolean {
  return NUDGE_RE.test(text.trim());
}

export interface InsightsMetrics {
  prompts: number;
  nudges: number;
  interrupts: number;
  continuations: number;
  notifications: number;
  compacts: number;
  modelSwitches: number;
  effortSwitches: number;
  errorPastes: number;
}

export function computeMetrics(turns: Turn[], ignore: RegExp[] = []): InsightsMetrics {
  const metrics: InsightsMetrics = {
    prompts: 0,
    nudges: 0,
    interrupts: 0,
    continuations: 0,
    notifications: 0,
    compacts: 0,
    modelSwitches: 0,
    effortSwitches: 0,
    errorPastes: 0,
  };

  for (const turn of turns) {
    if (turn.role !== "user" || !turn.text) continue;
    const text = turn.text.trim();
    if (text.startsWith("[Request interrupted")) {
      metrics.interrupts++;
      continue;
    }

    const command = TAG_RE.exec(text)?.[1]?.toLowerCase();
    if (command) {
      if (command === "compact") metrics.compacts++;
      else if (command === "model") metrics.modelSwitches++;
      else if (command === "effort") metrics.effortSwitches++;
      continue;
    }

    switch (classifyPrompt(text, ignore)) {
      case "continuation":
        metrics.continuations++;
        continue;
      case "notification":
        metrics.notifications++;
        continue;
      case "injected":
        continue;
      case "human":
        break;
    }

    metrics.prompts++;
    if (isNudgeText(text)) metrics.nudges++;
    if (extractPasteKey(text)) metrics.errorPastes++;
  }
  return metrics;
}

export async function sumAutopilotAvoided(home?: string): Promise<number> {
  await cleanupStale(home);
  try {
    let sum = 0;
    for (const file of await readdir(stateDir(home))) {
      if (!file.endsWith(".json")) continue;
      sum += (await loadState(file.slice(0, -5), home)).count;
    }
    return sum;
  } catch {
    return 0;
  }
}

export interface Recommendation {
  metric: string;
  line: string;
}

export function buildRecommendations(
  metrics: InsightsMetrics,
  context: {
    autopilotMode: AutopilotMode | undefined;
    avoided: number;
    recallInstalled: boolean;
    unusedArtifacts: string[];
  },
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const autopilotOn = context.autopilotMode === "nudge" || context.autopilotMode === "full";
  if (autopilotOn) {
    recommendations.push({
      metric: "nudges",
      line: `autopilot on — ${context.avoided} nudge(s) avoided (7d)`,
    });
  } else if (metrics.nudges > 10) {
    recommendations.push({
      metric: "nudges",
      line: `you typed ${metrics.nudges} nudges — try: gradient autopilot nudge`,
    });
  }
  if (metrics.continuations + metrics.compacts > 10) {
    recommendations.push({
      metric: "context",
      line: `${metrics.continuations} context death(s), ${metrics.compacts} compact(s) — try: gradient continuity on`,
    });
  }
  if (metrics.interrupts > 20) {
    recommendations.push({
      metric: "interrupts",
      line: `${metrics.interrupts} interrupted turns — consider plan mode for bigger asks`,
    });
  }
  if (metrics.errorPastes > 10) {
    recommendations.push({
      metric: "pastes",
      line: `${metrics.errorPastes} pasted error dumps — run gradient scan; paste patterns become skills`,
    });
  }
  if (metrics.modelSwitches > 10 || metrics.effortSwitches > 10) {
    recommendations.push({
      metric: "model",
      line: `${metrics.modelSwitches} /model and ${metrics.effortSwitches} /effort switches — pin defaultModel in .claude/settings.json per project`,
    });
  }
  if (!context.recallInstalled) {
    recommendations.push({
      metric: "recall",
      line: "recall hook off — gradient recall on hints when a typed prompt matches an artifact",
    });
  }
  for (const name of context.unusedArtifacts) {
    recommendations.push({ metric: "adoption", line: `unused 30d+: gradient remove ${name}` });
  }
  recommendations.push({
    metric: "permissions",
    line: "permission friction? Claude Code's built-in /fewer-permission-prompts mines an allowlist",
  });
  return recommendations;
}
