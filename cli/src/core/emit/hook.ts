import type { Suggestion } from "../types.js";
import { assertHookRunnable } from "../validate.js";

const KNOWN_HOOK_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "UserPromptSubmit", "Notification",
  "Stop", "SubagentStop", "PreCompact", "SessionStart", "SessionEnd",
]);

export function emitHook(s: Suggestion): { settingsPatch: string } {
  if (s.payload.type !== "hook") throw new Error("emitHook needs a hook payload");
  assertHookRunnable(s);
  if (!KNOWN_HOOK_EVENTS.has(s.payload.event)) {
    throw new Error(`unknown hook event: ${s.payload.event}`);
  }
  const patch = {
    hooks: {
      [s.payload.event]: [
        { hooks: [{ type: "command", command: `gradient ${s.payload.subcommand}` }] },
      ],
    },
  };
  return { settingsPatch: JSON.stringify(patch, null, 2) };
}
