import type { Suggestion } from "../types.js";
import { sanitizeName } from "../security.js";
import { artifactMarker } from "../manifest.js";

/** Shared Agent Skills description builder. */
export function buildSkillDescription(title: string, triggers?: string[]): string {
  const cleanTitle = title.replace(/[\r\n]+/g, " ").trim();
  const cleanTriggers = (triggers ?? [])
    .map(trigger => JSON.stringify(trigger.replace(/[\r\n]+/g, " ").trim()))
    .join(", ");
  return cleanTriggers
    ? `${cleanTitle}. Use when the user says things like: ${cleanTriggers}.`
    : cleanTitle;
}

/** Command payload → model-invokable Claude Code skill. */
export function emitSkill(
  suggestion: Suggestion,
  opts: { model?: string } = {},
): { path: string; content: string } {
  if (suggestion.payload.type !== "command") throw new Error("emitSkill needs a command payload");
  const name = sanitizeName(suggestion.payload.commandName);
  const description = buildSkillDescription(suggestion.title, suggestion.payload.triggers);
  const model = opts.model && suggestion.payload.mechanical
    ? `model: ${JSON.stringify(opts.model)}\n`
    : "";
  const content =
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${model}---\n` +
    `${artifactMarker(suggestion)}\n${suggestion.payload.body}\n`;
  return { path: `.claude/skills/${name}/SKILL.md`, content };
}
