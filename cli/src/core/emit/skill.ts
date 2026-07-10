import type { Suggestion } from "../types.js";
import { sanitizeName } from "../security.js";

/** Shared Agent Skills description builder. */
export function buildSkillDescription(title: string, triggers?: string[]): string {
  const cleanTitle = title.replace(/[\r\n]+/g, " ").trim();
  const cleanTriggers = (triggers ?? [])
    .map(t => JSON.stringify(t.replace(/[\r\n]+/g, " ").trim()))
    .join(", ");
  return cleanTriggers
    ? `${cleanTitle}. Use when the user says things like: ${cleanTriggers}.`
    : cleanTitle;
}

/** Command payload → model-invokable Claude Code skill. */
export function emitSkill(
  s: Suggestion,
  opts: { model?: string } = {},
): { path: string; content: string } {
  if (s.payload.type !== "command") throw new Error("emitSkill needs a command payload");
  const name = sanitizeName(s.payload.commandName);
  const description = buildSkillDescription(s.title, s.payload.triggers);
  const model = opts.model && s.payload.mechanical
    ? `model: ${JSON.stringify(opts.model)}\n`
    : "";
  const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${model}---\n${s.payload.body}\n`;
  return { path: `.claude/skills/${name}/SKILL.md`, content };
}
