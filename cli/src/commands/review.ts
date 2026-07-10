import { createInterface } from "node:readline/promises";
import type { Suggestion } from "../core/types.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { isNudge } from "../core/playbook.js";
import { loadSuggestions, syncApprovedPlaybook } from "./apply.js";
import { loadConfig } from "../config.js";
import { refreshRecallIndex } from "./recall.js";
import { emit, type EmitTarget } from "../core/emit/index.js";
import { stripUnsafeControls } from "../core/security.js";

export type Prompter = (
  s: Suggestion,
  index: number,
  total: number,
  preview: string,
) => Promise<"approve" | "skip" | "quit">;

export function suggestionPreview(s: Suggestion, target: EmitTarget): string {
  const rendered = emit(s, { target });
  if (rendered.kind === "command" || rendered.kind === "skill" || rendered.kind === "rule") {
    return `${rendered.path}\n${rendered.content}`;
  }
  if (rendered.kind === "loop") return rendered.command;
  if (rendered.kind === "rule-print") return rendered.text;
  return rendered.settingsPatch;
}

export async function review(
  projectDir: string,
  prompt: Prompter,
  opts: { home?: string } = {},
): Promise<ApplyResult[]> {
  const suggestions = await loadSuggestions(projectDir, opts.home);
  const config = await loadConfig(opts.home);
  const emitTarget = config.emitTarget ?? "skill";
  const out: ApplyResult[] = [];
  for (let i = 0; i < suggestions.length; i++) {
    const decision = await prompt(
      suggestions[i], i, suggestions.length,
      suggestionPreview(suggestions[i], emitTarget),
    );
    if (decision === "quit") break;
    if (decision === "approve") {
      out.push(await applySuggestion(suggestions[i], projectDir, { emitTarget }));
    }
  }
  if (out.length > 0) {
    await syncApprovedPlaybook(projectDir, suggestions, opts.home);
    await refreshRecallIndex(projectDir, opts.home);
  }
  return out;
}

export function readlinePrompter(): Prompter {
  return async (s, index, total, preview) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const label = s.payload.type;
    process.stdout.write(
      `\n(${index + 1}/${total})  ${s.name} · ${label} · seen ${s.evidence.count}× · ${s.confidence}\n  ${s.title}\n\n${stripUnsafeControls(preview)}\n`,
    );
    if (isNudge(s)) {
      process.stdout.write("  tip: this is what autopilot automates → gradient autopilot nudge\n");
    }
    const ans = (await rl.question("  [a]pprove [s]kip [q]uit › ")).trim().toLowerCase();
    rl.close();
    if (ans === "a") return "approve";
    if (ans === "q") return "quit";
    return "skip";
  };
}
