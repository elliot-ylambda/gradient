import type { Suggestion } from "../types.js";

/** Codex standing guidance is deliberately print-only: AGENTS.md may contain
 * hand-written team policy, so gradient never edits it automatically. */
export function emitCodexRule(s: Suggestion): { printed: string } {
  if (s.payload.type !== "rule") throw new Error("emitCodexRule needs a rule payload");
  const destination = s.payload.target === "project" ? "the repository AGENTS.md" : "~/.codex/AGENTS.md";
  return {
    printed: `Codex rule (manual): add this to ${destination}:\n- ${s.payload.text}`,
  };
}
