import { createInterface } from "node:readline/promises";
import type { Assistant, Suggestion } from "../core/types.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { isNudge } from "../core/playbook.js";
import { loadSuggestions, saveSuggestions } from "./apply.js";
import { loadConfig, resolveCheapModel, resolveTargets } from "../config.js";
import { refreshRecallIndex } from "./recall.js";

export type Prompter = (s: Suggestion, index: number, total: number) => Promise<"approve" | "skip" | "quit">;
/** Returns an option label, or null to leave the suggestion unresolved. */
export type Clarifier = (s: Suggestion) => Promise<string | null>;

/** Replace an ambiguous command body with the user's chosen reading while
 * retaining the mined pattern's stable identity and clarification provenance. */
export function resolveClarify(s: Suggestion, label: string): Suggestion | null {
  const clarify = s.clarify;
  if (s.confidence !== "flagged" || !clarify || clarify.chosen || s.payload.type !== "command") return null;
  const option = clarify.options.find(candidate => candidate.label === label);
  if (!option) return null;
  return {
    ...s,
    confidence: "high",
    payload: { ...s.payload, body: option.body },
    clarify: { ...clarify, chosen: option.label },
  };
}

export async function review(
  projectDir: string,
  prompt: Prompter,
  opts: { home?: string; onSkip?: (message: string) => void; clarifier?: Clarifier } = {},
): Promise<ApplyResult[]> {
  const suggestions = await loadSuggestions(projectDir, opts.onSkip);
  const config = await loadConfig(opts.home);
  const emitTarget = config.emitTarget ?? "skill";
  const targets = resolveTargets(config);
  const cheapModel = resolveCheapModel(config);
  const out: ApplyResult[] = [];
  for (let i = 0; i < suggestions.length; i++) {
    let suggestion = suggestions[i];
    if (
      opts.clarifier &&
      suggestion.confidence === "flagged" &&
      suggestion.clarify &&
      !suggestion.clarify.chosen &&
      suggestion.payload.type === "command"
    ) {
      const label = await opts.clarifier(suggestion);
      const resolved = label === null ? null : resolveClarify(suggestion, label);
      // An unresolved ambiguity is never eligible for approval in this pass.
      if (!resolved) continue;
      suggestions[i] = suggestion = resolved;
      // Persist the human decision before artifact I/O so provenance survives
      // even if a target write fails.
      await saveSuggestions(projectDir, suggestions);
    }

    const decision = await prompt(suggestion, i, suggestions.length);
    if (decision === "quit") break;
    if (decision === "approve") {
      out.push(await applySuggestion(suggestion, projectDir, { emitTarget, targets, cheapModel }));
    }
  }
  if (out.length > 0) await refreshRecallIndex(projectDir, opts.home);
  return out;
}

export function readlineClarifier(): Clarifier {
  return async suggestion => {
    const clarify = suggestion.clarify!;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(`\n  ${clarify.question}\n`);
    clarify.options.forEach((option, index) => {
      process.stdout.write(`    [${index + 1}] ${option.label} — ${option.body.slice(0, 80)}\n`);
    });
    const answer = (await rl.question("  choose a number (enter to decide later) › ")).trim();
    rl.close();
    const index = Number(answer) - 1;
    return clarify.options[index]?.label ?? null;
  };
}

export function readlinePrompter(
  opts: { targets?: Assistant[]; cheapModel?: string } = {},
): Prompter {
  return async (s, index, total) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const label = s.payload.type;
    process.stdout.write(
      `\n(${index + 1}/${total})  ${s.name} · ${label} · seen ${s.evidence.count}× · ${s.confidence}\n  ${s.title}\n`,
    );
    if (isNudge(s)) {
      process.stdout.write("  tip: this is what autopilot automates → gradient autopilot nudge\n");
    }
    const targets = opts.targets ?? ["claude-code"];
    if (targets.length > 1 || targets[0] !== "claude-code") {
      process.stdout.write(`  targets: ${targets.join(", ")}\n`);
    }
    if (s.payload.type === "command" && s.payload.mechanical && opts.cheapModel) {
      process.stdout.write(`  Claude Code model: ${opts.cheapModel} (mechanical workflow)\n`);
    }
    const ans = (await rl.question("  [a]pprove [s]kip [q]uit › ")).trim().toLowerCase();
    rl.close();
    if (ans === "a") return "approve";
    if (ans === "q") return "quit";
    return "skip";
  };
}
