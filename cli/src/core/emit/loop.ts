import type { LoopArtifact, SuggestionDraft } from "../../types";

/** Suggestion → a ready-to-run /loop line the user can paste into Claude Code. */
export function emitLoop(s: SuggestionDraft): LoopArtifact {
  const intent = s.title.replace(/\s+/g, " ").trim();
  return { kind: "loop", command: `/loop ${JSON.stringify(intent)}` };
}
