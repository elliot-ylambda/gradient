import type { ArtifactKind, Candidate, Suggestion, SuggestionDraft } from "../types";
import { hashId, slug } from "./security";
import { emitCommand } from "./emit/command";
import { emitLoop } from "./emit/loop";
import { emitHook } from "./emit/hook";

function nameFor(cand: Candidate): string {
  const guess = slug(cand.signature.split(" ").slice(0, 3).join("-"));
  return guess || "task";
}

function artifactFor(type: ArtifactKind, draft: SuggestionDraft) {
  if (type === "command") return emitCommand(draft);
  if (type === "loop") return emitLoop(draft);
  return emitHook(draft);
}

/**
 * No-LLM path (spec §6 graceful degradation): high-confidence exact-repeat
 * candidates become Suggestions without a model. The LLM is only needed to
 * formalize `inferred`/`flagged` candidates — wired through `detect()` later.
 */
export function detectNoLLM(candidates: Candidate[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const cand of candidates) {
    if (cand.kind === "unknown") continue;
    const type = cand.kind;
    const name = nameFor(cand);
    const draft: SuggestionDraft = {
      id: hashId(cand.signature),
      type,
      name,
      title: cand.examples[0] ?? cand.signature,
      rationale: `Repeated ${cand.count}× across ${cand.sessions} sessions.`,
      evidence: { count: cand.count, sessions: cand.sessions },
      confidence: cand.confidence,
    };
    out.push({ ...draft, artifact: artifactFor(type, draft) });
  }
  return out;
}

// TODO(v1): detect(candidates, llm) — send top-N inferred/flagged candidates to
// the LLMBackend to confirm/name/emit, merging with the no-LLM high-confidence set.
