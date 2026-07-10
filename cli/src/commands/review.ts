import { createInterface } from "node:readline/promises";
import type { Assistant, Suggestion } from "../core/types.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { isNudge } from "../core/playbook.js";
import { loadSuggestions } from "./apply.js";
import { loadConfig, resolveCheapModel, resolveTargets } from "../config.js";
import { refreshRecallIndex } from "./recall.js";

export type Prompter = (s: Suggestion, index: number, total: number) => Promise<"approve" | "skip" | "quit">;

export async function review(
  projectDir: string,
  prompt: Prompter,
  opts: { home?: string; onSkip?: (message: string) => void } = {},
): Promise<ApplyResult[]> {
  const suggestions = await loadSuggestions(projectDir, opts.onSkip);
  const config = await loadConfig(opts.home);
  const emitTarget = config.emitTarget ?? "skill";
  const targets = resolveTargets(config);
  const cheapModel = resolveCheapModel(config);
  const out: ApplyResult[] = [];
  for (let i = 0; i < suggestions.length; i++) {
    const decision = await prompt(suggestions[i], i, suggestions.length);
    if (decision === "quit") break;
    if (decision === "approve") {
      out.push(await applySuggestion(suggestions[i], projectDir, { emitTarget, targets, cheapModel }));
    }
  }
  if (out.length > 0) await refreshRecallIndex(projectDir, opts.home);
  return out;
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
