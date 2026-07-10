import { createInterface } from "node:readline/promises";
import type { Assistant, Suggestion } from "../core/types.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { isNudge } from "../core/playbook.js";
import { loadSuggestions, syncApprovedPlaybook } from "./apply.js";
import { loadConfig, resolveCheapModel, resolveTargets } from "../config.js";
import { refreshRecallIndex } from "./recall.js";
import { emit, type EmitTarget } from "../core/emit/index.js";
import { stripUnsafeControls } from "../core/security.js";

export type Prompter = (
  suggestion: Suggestion,
  index: number,
  total: number,
  preview: string,
) => Promise<"approve" | "skip" | "quit">;

function renderedText(suggestion: Suggestion, target: Assistant, emitTarget: EmitTarget, cheapModel?: string): string {
  if (target === "codex" && suggestion.payload.type !== "command" && suggestion.payload.type !== "rule") {
    return `[${target}]\n(skipped: this artifact type is not supported)`;
  }
  const rendered = emit(suggestion, { target: emitTarget, assistant: target, cheapModel });
  const body = rendered.kind === "command" || rendered.kind === "skill" || rendered.kind === "rule"
    ? `${rendered.path}\n${rendered.content}`
    : rendered.kind === "loop"
      ? rendered.command
      : rendered.kind === "rule-print"
        ? rendered.text
        : rendered.settingsPatch;
  return `[${target}]\n${body}`;
}

export function suggestionPreview(
  suggestion: Suggestion,
  emitTarget: EmitTarget,
  opts: { targets?: Assistant[]; cheapModel?: string } = {},
): string {
  return (opts.targets ?? ["claude-code"])
    .map(target => renderedText(suggestion, target, emitTarget, opts.cheapModel))
    .join("\n\n");
}

export async function review(
  projectDir: string,
  prompt: Prompter,
  opts: { home?: string; onSkip?: (message: string) => void } = {},
): Promise<ApplyResult[]> {
  const suggestions = await loadSuggestions(projectDir, opts);
  const config = await loadConfig(opts.home);
  const emitTarget = config.emitTarget ?? "skill";
  const targets = resolveTargets(config);
  const cheapModel = resolveCheapModel(config);
  const out: ApplyResult[] = [];
  for (let index = 0; index < suggestions.length; index++) {
    const suggestion = suggestions[index];
    const decision = await prompt(
      suggestion,
      index,
      suggestions.length,
      suggestionPreview(suggestion, emitTarget, { targets, cheapModel }),
    );
    if (decision === "quit") break;
    if (decision === "approve") {
      out.push(await applySuggestion(suggestion, projectDir, {
        emitTarget,
        targets,
        cheapModel,
        home: opts.home,
      }));
    }
  }
  if (out.length > 0) {
    await syncApprovedPlaybook(projectDir, suggestions, opts.home);
    await refreshRecallIndex(projectDir, opts.home);
  }
  return out;
}

export function readlinePrompter(
  _opts: { targets?: Assistant[]; cheapModel?: string } = {},
): Prompter {
  return async (suggestion, index, total, preview) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const label = suggestion.payload.type;
    process.stdout.write(
      `\n(${index + 1}/${total})  ${suggestion.name} · ${label} · seen ${suggestion.evidence.count}× · ${suggestion.confidence}\n` +
      `  ${suggestion.title}\n\n${stripUnsafeControls(preview)}\n`,
    );
    if (isNudge(suggestion)) {
      process.stdout.write("  tip: this is what autopilot automates → gradient autopilot nudge\n");
    }
    const answer = (await rl.question("  [a]pprove [s]kip [q]uit › ")).trim().toLowerCase();
    rl.close();
    if (answer === "a") return "approve";
    if (answer === "q") return "quit";
    return "skip";
  };
}
