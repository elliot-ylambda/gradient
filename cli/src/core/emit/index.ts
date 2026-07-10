import type { Suggestion } from "../types.js";
import { emitCommand } from "./command.js";
import { emitLoop } from "./loop.js";
import { emitHook } from "./hook.js";
import { emitSkill } from "./skill.js";
import { emitRule } from "./rule.js";

export type EmitTarget = "skill" | "command";
export type EmitResult =
  | { kind: "command"; path: string; content: string }
  | { kind: "skill"; path: string; content: string }
  | { kind: "loop"; command: string }
  | { kind: "hook"; settingsPatch: string }
  | { kind: "rule"; path: string; content: string }
  | { kind: "rule-print"; text: string };

export { emitSkill };

export function emit(s: Suggestion, opts: { target?: EmitTarget } = {}): EmitResult {
  switch (s.payload.type) {
    case "command":
      return (opts.target ?? "skill") === "command"
        ? { kind: "command", ...emitCommand(s) }
        : { kind: "skill", ...emitSkill(s) };
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
