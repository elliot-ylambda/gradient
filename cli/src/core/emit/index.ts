import type { Assistant, Suggestion } from "../types.js";
import { emitCommand } from "./command.js";
import { emitLoop } from "./loop.js";
import { emitHook } from "./hook.js";
import { emitSkill } from "./skill.js";
import { emitRule } from "./rule.js";
import { emitCodexSkill } from "./codex-skill.js";

export type EmitTarget = "skill" | "command";
export interface EmitOpts {
  target?: EmitTarget;
  assistant?: Assistant;
  cheapModel?: string;
}
export type EmitResult =
  | { kind: "command"; path: string; content: string }
  | { kind: "skill"; path: string; content: string; assistant: Assistant }
  | { kind: "loop"; command: string }
  | { kind: "hook"; settingsPatch: string }
  | { kind: "rule"; path: string; content: string }
  | { kind: "rule-print"; text: string };

export { emitSkill };

export function emit(s: Suggestion, opts: EmitOpts = {}): EmitResult {
  const assistant = opts.assistant ?? "claude-code";
  if (assistant === "codex" && s.payload.type !== "command") {
    throw new Error("codex target supports command-to-skill payloads only");
  }
  switch (s.payload.type) {
    case "command":
      if (assistant === "codex") {
        return { kind: "skill", assistant, ...emitCodexSkill(s) };
      }
      return (opts.target ?? "skill") === "command"
        ? { kind: "command", ...emitCommand(s) }
        : { kind: "skill", assistant, ...emitSkill(s, { model: opts.cheapModel }) };
    case "loop": return { kind: "loop", ...emitLoop(s) };
    case "hook": return { kind: "hook", ...emitHook(s) };
    case "rule": {
      const result = emitRule(s);
      return "path" in result
        ? { kind: "rule", ...result }
        : { kind: "rule-print", text: result.printed };
    }
  }
}
