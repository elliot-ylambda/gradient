import type { Suggestion } from "../types.js";
import { redact } from "../security.js";
import { entryTag } from "../playbook-splice.js";

/**
 * One tagged bullet for the repository's AGENTS.md.
 *
 * Codex has no `rules/` directory, so a standing instruction for it has to live
 * in a file the user also writes in. The tag is what makes that acceptable:
 * gradient owns exactly its own line under its own heading, applies
 * idempotently, and removes by splicing that line out rather than touching the
 * file as a whole.
 */
export function emitCodexRule(s: Suggestion): { line: string } {
  if (s.payload.type !== "rule") throw new Error("emitCodexRule needs a rule payload");
  const text = redact(s.payload.text).replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
  return { line: `- ${text} ${entryTag(s.id)}` };
}
