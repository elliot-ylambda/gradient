import type { Turn, CommandEvent, AutopilotMode } from "./types.js";
import { classifyPrompt } from "./filter.js";
import { extractPasteKey, PASTE_MIN_COUNT } from "./paste.js";
import { cleanupStale, listStateFiles, loadState } from "./state.js";
import type { InstructionTally } from "./audit.js";

const NUDGE_RE = /^(continue|go on|keep going|next|what'?s next|proceed|yes|y|ok|okay|do it|go|sure|yep|good|great|perfect|lgtm|looks good|approved?|ship it|sounds good)[.!?]*$/i;

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
}

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
    const command = event.command.replace(/^\//, "").toLowerCase();
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
    const classification = classifyPrompt(turn.text, ignore);
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
  if (totals.nudges.prompts > 0) rows.push({
    metric: "nudges",
    ...totals.nudges,
    line: costLine(totals.nudges.tokens, totals.nudges.prompts, "nudge prompt(s)", "gradient autopilot nudge"),
  });
  if (totals.continuations.prompts > 0) rows.push({
    metric: "continuations",
    ...totals.continuations,
    line: costLine(totals.continuations.tokens, totals.continuations.prompts, "context re-explain(s)", "gradient continuity on"),
  });
  if (totals.pastes.prompts > 0) rows.push({
    metric: "pastes",
    ...totals.pastes,
    line: costLine(totals.pastes.tokens, totals.pastes.prompts, "repeated error paste(s)", "gradient scan"),
  });
  return rows;
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
      line: `${metrics.errorPastes} pasted error dumps — run gradient scan; paste patterns become advisory troubleshooting guides`,
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

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function instructionEffectivenessLine(tally: InstructionTally): string {
  const text = tally.text.length > 60 ? `${tally.text.slice(0, 59)}…` : tally.text;
  const lastSeen = /^\d{4}-\d{2}-\d{2}/.test(tally.lastSeen) ? tally.lastSeen.slice(0, 10) : "unknown";
  return `"${text}" · restated ${tally.restatements}× · violated ${tally.violations}× · last seen ${lastSeen}`;
}

export function renderInsightsHtml(report: {
  label: string;
  avoided: number;
  metrics: InsightsMetrics;
  recommendations: Recommendation[];
  costs?: CostRow[];
  instructionEffectiveness?: InstructionTally[];
  toolActivity?: ToolActivityMetrics;
}): string {
  const metrics = report.metrics;
  const rows: Array<[string, number]> = [
    ["prompts", metrics.prompts],
    ["nudges", metrics.nudges],
    ["interrupts", metrics.interrupts],
    ["context deaths", metrics.continuations],
    ["compacts", metrics.compacts],
    ["error pastes", metrics.errorPastes],
    ["model switches", metrics.modelSwitches],
    ["effort switches", metrics.effortSwitches],
    ...(report.toolActivity ? [
      ["in-session failure loops", report.toolActivity.failureLoops] as [string, number],
      ["post-edit rituals", report.toolActivity.postEditRituals] as [string, number],
    ] : []),
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gradient insights</title>
<style>
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1a1a1a}
  @media (prefers-color-scheme:dark){body{background:#111;color:#eee}}
  h1{font-size:18px}.label{opacity:.65}
  dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px}
  dt{opacity:.65}dd{margin:0;font-variant-numeric:tabular-nums}
  ul{padding-left:18px}li{margin:6px 0}
</style></head><body>
<h1>gradient insights</h1>
<p class="label">${escapeHtml(report.label)} · autopilot avoided ${report.avoided} nudge(s)</p>
<dl>${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join("")}</dl>
${report.costs?.length ? `<h1>cost of unautomated habits</h1>
<ul>${report.costs.map(cost => `<li>${escapeHtml(cost.line)}</li>`).join("")}</ul>` : ""}
${report.instructionEffectiveness?.length ? `<h1>Instruction effectiveness</h1>
<ul>${report.instructionEffectiveness.map(tally => `<li>${escapeHtml(instructionEffectivenessLine(tally))}</li>`).join("")}</ul>
<p>These instructions aren't holding — run <code>gradient review</code> to convert them.</p>` : ""}
<h1>next</h1>
<ul>${report.recommendations.map(recommendation => `<li>${escapeHtml(recommendation.line)}</li>`).join("")}</ul>
</body></html>\n`;
}
