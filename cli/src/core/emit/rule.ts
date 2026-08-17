import type { Suggestion } from "../types.js";
import { redact, sanitizeName } from "../security.js";
import { artifactMarker } from "../manifest.js";

/**
 * A standing instruction as a gradient-owned file under `.claude/rules/`.
 *
 * Claude Code auto-loads every `.md` there at launch with the same priority as
 * `.claude/CLAUDE.md`, so this reaches the assistant without gradient ever
 * editing a file the user hand-wrote.
 */
export function emitRule(s: Suggestion): { path: string; content: string } {
  if (s.payload.type !== "rule") throw new Error("emitRule needs a rule payload");
  const text = redact(s.payload.text).slice(0, 2_000).trim();

  const name = sanitizeName(s.payload.ruleName);
  const suggestionName = sanitizeName(s.name);
  const title = redact(s.title).replace(/[\r\n]+/g, " ").trim().slice(0, 500);
  const content =
    `${artifactMarker(s)}\n` +
    `<!-- remove with: gradient remove ${suggestionName} -->\n` +
    `# ${title}\n\n${text}\n`;
  return { path: `.claude/rules/gradient-${name}.md`, content };
}
