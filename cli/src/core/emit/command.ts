import type { Suggestion } from "../types.js";
import { sanitizeName } from "../security.js";

export function emitCommand(s: Suggestion): { path: string; content: string } {
  if (s.payload.type !== "command") throw new Error("emitCommand needs a command payload");
  const name = sanitizeName(s.payload.commandName);
  const content = `---\ndescription: ${s.title}\n---\n${s.payload.body}\n`;
  return { path: `.claude/commands/${name}.md`, content };
}
