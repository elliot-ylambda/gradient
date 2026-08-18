import type { Turn, CommandEvent, AutopilotMode } from "./types.js";
import { classifyTurn } from "./filter.js";
import { extractPasteKey, PASTE_MIN_COUNT } from "./paste.js";
import { cleanupStale, listStateFiles, loadState } from "./state.js";
import { commandKey } from "./command.js";

const NUDGE_RE = /^(continue( (from )?where you left off)?|go on|keep going|carry on|resume|next|what'?s next|proceed|yes|y|ok|okay|do it|go|sure|yep|good|great|perfect|lgtm|looks good( to me)?|approved?|ship it|sounds good)[.!?,]*$/i;

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

export interface ToolActivityMetrics {
  failureLoops: number;
  postEditRituals: number;
  /** Tool calls the permission layer refused. Not failures — the command never
   *  ran — but repeated approval prompts are their own friction. */
  permissionPrompts: number;
}

/** Below this, an approval prompt is a normal part of working, not a pattern. */
export const PERMISSION_PROMPT_MIN = 5;

export function computeMetrics(turns: Turn[], events: CommandEvent[] = [], ignore: RegExp[] = []): InsightsMetrics {
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

  for (const event of events) {
    const command = commandKey(event.command);
    if (command === "compact") metrics.compacts++;
    else if (command === "model") metrics.modelSwitches++;
    else if (command === "effort") metrics.effortSwitches++;
  }

  for (const turn of turns) {
    if (turn.role !== "user" || !turn.text) continue;
    const text = turn.text.trim();
    if (text.startsWith("[Request interrupted")) {
      metrics.interrupts++;
      continue;
    }

    // classifyTurn, not classifyPrompt: the transcript records how a prompt
    // entered the session, and text heuristics cannot tell a typed request from
    // a skill body the harness expanded into the user role. Using the weaker
    // test here made the report and `scan` disagree about the same corpus.
    switch (classifyTurn(turn, ignore)) {
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
    for (const file of await listStateFiles(home)) {
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

export interface CostRow {
  metric: "nudges" | "continuations" | "pastes";
  tokens: number;
  prompts: number;
  line: string;
  /** True when the suggested action actually avoids re-sending these tokens.
   *  Nudges are not recoverable: autopilot still sends the same turn (plus a
   *  judge call), so automating them buys back attention, never tokens. */
  recoverable: boolean;
}

function tokensFor(turn: Turn): number {
  if (typeof turn.usageTokens === "number" && Number.isFinite(turn.usageTokens) && turn.usageTokens > 0) {
    return Math.round(turn.usageTokens);
  }
  return Math.ceil((turn.text?.length ?? 0) / 4);
}

function costLine(tokens: number, prompts: number, label: string, action: string): string {
  return `≈${tokens.toLocaleString("en-US")} tokens · ${prompts} ${label} · ${action}`;
}

/** Same measurement, honest claim: the tokens were spent, but the suggested
 *  action does not win them back — it removes the turn you had to type. */
function attentionLine(tokens: number, prompts: number, label: string, action: string): string {
  return `${prompts} ${label} across ≈${tokens.toLocaleString("en-US")} tokens of turns you had to drive ` +
    `(automating saves attention, not tokens) · ${action}`;
}

/** Token-attributed cost of habits gradient can remove. Tokens stay approximate:
 * recorded model-turn usage is attributable but not necessarily incremental,
 * while older transcripts use the conventional chars/4 fallback. */
export function buildCostRows(turns: Turn[], ignore: RegExp[] = []): CostRow[] {
  const pasteCounts = new Map<string, number>();
  for (const turn of turns) {
    if (turn.role !== "user" || !turn.text) continue;
    const key = extractPasteKey(turn.text);
    if (key) pasteCounts.set(key, (pasteCounts.get(key) ?? 0) + 1);
  }

  const totals = {
    nudges: { tokens: 0, prompts: 0 },
    continuations: { tokens: 0, prompts: 0 },
    pastes: { tokens: 0, prompts: 0 },
  };
  for (const turn of turns) {
    if (turn.role !== "user" || !turn.text) continue;
    const classification = classifyTurn(turn, ignore);
    if (classification === "continuation") {
      totals.continuations.prompts++;
      totals.continuations.tokens += tokensFor(turn);
      continue;
    }
    if (classification !== "human") continue;
    if (isNudgeText(turn.text)) {
      totals.nudges.prompts++;
      totals.nudges.tokens += tokensFor(turn);
    }
    const key = extractPasteKey(turn.text);
    if (key && (pasteCounts.get(key) ?? 0) >= PASTE_MIN_COUNT) {
      totals.pastes.prompts++;
      totals.pastes.tokens += tokensFor(turn);
    }
  }

  const rows: CostRow[] = [];
  // Recoverable rows first: a reader scanning top-down should meet the tokens
  // an action actually wins back before the (usually much larger) attention row.
  if (totals.continuations.prompts > 0) rows.push({
    metric: "continuations",
    ...totals.continuations,
    recoverable: true,
    line: costLine(totals.continuations.tokens, totals.continuations.prompts, "context re-explain(s)", "gradient on continuity"),
  });
  if (totals.pastes.prompts > 0) rows.push({
    metric: "pastes",
    ...totals.pastes,
    recoverable: true,
    line: costLine(totals.pastes.tokens, totals.pastes.prompts, "repeated error paste(s)", "gradient optimize"),
  });
  if (totals.nudges.prompts > 0) rows.push({
    metric: "nudges",
    ...totals.nudges,
    recoverable: false,
    line: attentionLine(totals.nudges.tokens, totals.nudges.prompts, "nudge prompt(s)", "gradient on autopilot"),
  });
  return rows;
}

export function buildRecommendations(
  metrics: InsightsMetrics,
  context: {
    autopilotMode: AutopilotMode | undefined;
    avoided: number;
    unusedArtifacts: string[];
    permissionPrompts: number;
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
      line: `you typed ${metrics.nudges} nudges — try: gradient on autopilot`,
    });
  }
  if (metrics.continuations + metrics.compacts > 10) {
    recommendations.push({
      metric: "context",
      line: `${metrics.continuations} context death(s), ${metrics.compacts} compact(s) — try: gradient on continuity`,
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
      line: `${metrics.errorPastes} pasted error dumps — run gradient optimize; paste patterns become advisory troubleshooting guides`,
    });
  }
  if (metrics.modelSwitches > 10 || metrics.effortSwitches > 10) {
    recommendations.push({
      metric: "model",
      line: `${metrics.modelSwitches} /model and ${metrics.effortSwitches} /effort switches — pin defaultModel in .claude/settings.json per project`,
    });
  }
  for (const name of context.unusedArtifacts) {
    recommendations.push({ metric: "adoption", line: `unused 30d+: gradient remove ${name}` });
  }
  // Printed only when the transcripts show it. Unconditional advice is noise
  // dressed as a finding: it appeared under every report gradient has ever
  // produced, including for users with no permission friction at all, and a
  // recommendation that is always true teaches the reader to skip the section.
  if (context.permissionPrompts >= PERMISSION_PROMPT_MIN) {
    recommendations.push({
      metric: "permissions",
      line: `${context.permissionPrompts} approval prompt(s) interrupted a tool call — ` +
        "Claude Code's built-in /fewer-permission-prompts mines an allowlist",
    });
  }
  return recommendations;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
