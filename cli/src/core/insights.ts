import type { Turn } from "./types.js";
import { classifyPrompt } from "./filter.js";
import { extractPasteKey } from "./paste.js";

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
