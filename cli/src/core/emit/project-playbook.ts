import type { Suggestion } from "../types.js";
import { redact } from "../security.js";
import { entryTag, type PlaybookSection } from "../playbook-splice.js";

/** One tagged bullet for the committed gradient.md. The tag is how apply
 * stays idempotent and remove finds exactly its own line. */
export function emitProjectPlaybook(s: Suggestion): { section: PlaybookSection; line: string } {
  if (s.payload.type !== "project-playbook") throw new Error("emitProjectPlaybook needs a project-playbook payload");
  const text = redact(s.payload.text).replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
  return { section: s.payload.section, line: `- ${text} ${entryTag(s.id)}` };
}
