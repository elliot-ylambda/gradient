import type { Suggestion } from "../types.js";
import { emitCommand } from "./command.js";
import { emitLoop } from "./loop.js";
import { emitHook } from "./hook.js";

export type EmitResult =
  | { kind: "command"; path: string; content: string }
  | { kind: "loop"; command: string }
  | { kind: "hook"; settingsPatch: string };

export function emit(s: Suggestion): EmitResult {
  switch (s.payload.type) {
    case "command": return { kind: "command", ...emitCommand(s) };
    case "loop": return { kind: "loop", ...emitLoop(s) };
    case "hook": return { kind: "hook", ...emitHook(s) };
  }
}
