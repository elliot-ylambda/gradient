import type { Suggestion } from "../types.js";
import { sanitizeName } from "../security.js";
import { artifactMarker } from "../manifest.js";

export function emitCommand(s: Suggestion): { path: string; content: string } {
  if (s.payload.type !== "command") throw new Error("emitCommand needs a command payload");
  const name = sanitizeName(s.payload.commandName);
  // Collapse to one line and emit the description as a JSON string scalar (valid YAML),
  // so a title containing newlines or quotes cannot inject extra frontmatter keys.
  const description = JSON.stringify(s.title.replace(/[\r\n]+/g, " ").trim());
  const content = `---\ndescription: ${description}\n---\n${artifactMarker(s)}\n${s.payload.body}\n`;
  return { path: `.claude/commands/${name}.md`, content };
}
