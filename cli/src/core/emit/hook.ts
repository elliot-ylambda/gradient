import type { Suggestion } from "../types.js";
import { assertHookRunnable } from "../validate.js";

export function emitHook(s: Suggestion): { settingsPatch: string } {
  if (s.payload.type !== "hook") throw new Error("emitHook needs a hook payload");
  assertHookRunnable(s);
  const patch = {
    hooks: {
      [s.payload.event]: [
        { hooks: [{ type: "command", command: `gradient ${s.payload.subcommand}` }] },
      ],
    },
  };
  return { settingsPatch: JSON.stringify(patch, null, 2) };
}
