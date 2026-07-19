import type { Suggestion } from "../types.js";
import { sanitizeName } from "../security.js";
import { buildSkillDescription } from "./skill.js";
import { artifactMarker } from "../manifest.js";

/** Current Codex repository skill location (Agent Skills standard). */
export const CODEX_SKILLS_DIR = ".agents/skills";

/** Emit only the frontmatter fields documented by Codex. */
export function emitCodexSkill(s: Suggestion): { path: string; content: string } {
  if (s.payload.type !== "command") throw new Error("emitCodexSkill needs a command payload");
  const name = sanitizeName(s.payload.commandName);
  const description = buildSkillDescription(s.title, s.payload.triggers);
  return {
    path: `${CODEX_SKILLS_DIR}/${name}/SKILL.md`,
    content: `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${artifactMarker(s)}\n${s.payload.body}\n`,
  };
}
