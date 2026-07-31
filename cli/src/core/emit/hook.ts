import type { Suggestion } from "../types.js";
import { assertHookRunnable } from "../validate.js";
import { DEFAULT_HOOK_BINARY } from "../hookBinary.js";

const KNOWN_HOOK_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "UserPromptSubmit", "Notification",
  "Stop", "SubagentStop", "PreCompact", "SessionStart", "SessionEnd",
]);

export interface HookInstall {
  event: string;
  matcher?: string;
  command: string;
}

export function emitHook(
  s: Suggestion,
  hookBinary: string = DEFAULT_HOOK_BINARY,
): { settingsPatch?: string; install?: HookInstall } {
  if (s.payload.type !== "hook") throw new Error("emitHook needs a hook payload");
  assertHookRunnable(s);
  if (!KNOWN_HOOK_EVENTS.has(s.payload.event)) {
    throw new Error(`unknown hook event: ${s.payload.event}`);
  }
  if (s.payload.command !== undefined) {
    return {
      install: {
        event: s.payload.event,
        ...(s.payload.matcher !== undefined ? { matcher: s.payload.matcher } : {}),
        command: s.payload.command,
      },
    };
  }
  const group: {
    matcher?: string;
    hooks: Array<{ type: string; command: string }>;
  } = {
    hooks: [{ type: "command", command: `${hookBinary} ${s.payload.subcommand}` }],
  };
  if (s.payload.matcher) group.matcher = s.payload.matcher;
  const patch = {
    hooks: {
      [s.payload.event]: [group],
    },
  };
  return { settingsPatch: JSON.stringify(patch, null, 2) };
}
