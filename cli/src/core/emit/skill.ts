import type { Suggestion } from "../types.js";
import { sanitizeName } from "../security.js";

/** Command payload → model-invokable Claude Code skill. Triggers (the mined
 * phrasings) go into the description so Claude auto-invokes it (spec §3 A2). */
export function emitSkill(s: Suggestion): { path: string; content: string } {
  if (s.payload.type !== "command") throw new Error("emitSkill needs a command payload");
  const name = sanitizeName(s.payload.commandName);
  const title = s.title.replace(/[\r\n]+/g, " ").trim();
  const triggers = (s.payload.triggers ?? [])
    .map(t => JSON.stringify(t.replace(/[\r\n]+/g, " ").trim()))
    .join(", ");
  const description = triggers ? `${title}. Use when the user says things like: ${triggers}.` : title;
  const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${s.payload.body}\n`;
  return { path: `.claude/skills/${name}/SKILL.md`, content };
}
