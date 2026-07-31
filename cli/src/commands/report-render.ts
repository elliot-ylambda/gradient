import type { Report } from "./report.js";
import type { Suggestion } from "../core/types.js";
import { c, confidenceChip } from "../core/ui.js";
import { isMeasured } from "../core/classify.js";
import { instructionEffectivenessLine } from "../core/insights.js";
import { stripUnsafeControls } from "../core/security.js";

function oneLine(value: unknown): string {
  return stripUnsafeControls(String(value)).replace(/[\r\n\t]+/g, " ");
}

/**
 * The bare `gradient` report, in the order a reader needs it: what happened,
 * what it cost, what is already installed and whether it is used, what else is
 * running, and only then what to do next.
 */
export function renderReport(report: Report): string[] {
  const lines: string[] = [];
  const { insights } = report;
  const metrics = insights.metrics;

  lines.push(c.dim(insights.label));
  if (insights.capped) lines.push(c.dim("input cap reached; figures cover the bounded recent corpus"));
  lines.push(`  ${c.bold("prompts")} ${metrics.prompts}   ${c.bold("nudges")} ${metrics.nudges}   ${c.bold("interrupts")} ${metrics.interrupts}`);
  lines.push(`  ${c.bold("context deaths")} ${metrics.continuations}   ${c.bold("compacts")} ${metrics.compacts}   ${c.bold("error pastes")} ${metrics.errorPastes}`);
  lines.push(`  ${c.bold("model switches")} ${metrics.modelSwitches}   ${c.bold("effort switches")} ${metrics.effortSwitches}`);
  lines.push(
    `  ${c.bold("in-session failure loops")} ${insights.toolActivity.failureLoops}   ` +
    `${c.bold("post-edit rituals")} ${insights.toolActivity.postEditRituals}`,
  );

  if (insights.costs.length > 0) {
    lines.push(`\n${c.bold("cost of unautomated habits")}`);
    for (const cost of insights.costs) lines.push(`  ${c.violet("→")} ${cost.line}`);
  }

  if (insights.instructionEffectiveness?.length) {
    lines.push(`\n${c.bold("instructions that aren't holding")}`);
    for (const tally of insights.instructionEffectiveness) {
      lines.push(`  ${c.violet("→")} ${instructionEffectivenessLine(tally)}`);
    }
  }

  lines.push(...renderInstalled(report));
  lines.push(...renderPending(report.pending));

  if (report.board) {
    const board = report.board.trim();
    // A board with only this session in it says nothing worth a heading.
    if (board.split("\n").length > 1) {
      lines.push(`\n${c.bold("other sessions")}`);
      for (const line of board.split("\n")) lines.push(`  ${line}`);
    }
  }

  const featureLine = report.features
    .map(feature => `${feature.name} ${feature.on ? c.ok(feature.detail ?? "on") : c.muted("off")}`)
    .join("  ");
  lines.push(`\n${c.dim("features:")} ${featureLine}`);

  lines.push("");
  for (const recommendation of insights.recommendations) lines.push(`  ${c.violet("→")} ${recommendation.line}`);
  return lines;
}

function renderInstalled(report: Report): string[] {
  if (report.adoption.length === 0) return [];
  const lines = [`\n${c.bold("installed")}`];
  for (const artifact of report.adoption) {
    const lastUsed = artifact.lastUsed ? artifact.lastUsed.slice(0, 10) : "never";
    const realized = artifact.realizedMinutesSaved > 0 ? ` · ≈${artifact.realizedMinutesSaved}m saved` : "";
    const removal = artifact.suggestRemoval
      ? c.coral(`  → unused 30d+, consider: gradient remove ${oneLine(artifact.name)}`)
      : "";
    lines.push(
      `  ${c.bold(oneLine(artifact.name))}  ` +
      c.dim(`${artifact.uses} use(s)${realized} · last ${lastUsed}`) + removal,
    );
  }
  return lines;
}

function renderPending(pending: Suggestion[]): string[] {
  if (pending.length === 0) return [];
  const lines = [`\n${c.bold("pending suggestions")} ${c.dim("— review with gradient scan")}`];
  for (const suggestion of pending) {
    const tier = isMeasured(suggestion) ? c.dim(" measured") : "";
    lines.push(
      `  ${confidenceChip(suggestion.confidence)} ${c.bold(oneLine(suggestion.name))}  ` +
      `${c.muted(oneLine(suggestion.title))}${tier}`,
    );
  }
  return lines;
}
