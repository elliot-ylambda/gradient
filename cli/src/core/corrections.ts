import type { Candidate } from "./types.js";

/** Occurrence/session floors before a correction-shaped, kind-"unknown"
 * candidate becomes a "correction" candidate — the same repetition bar
 * classify.ts's markLoops applies to recurring runs, applied here to
 * unprompted user pushback instead. */
export const CORRECTION_MIN_COUNT = 3;
export const CORRECTION_MIN_SESSIONS = 2;

/** Correction openers: unprompted user pushback ("no, use pnpm", "don't add
 * comments", "stop adding comments to everything", "actually use the
 * existing helper", "i told you to run the tests first", "you didn't run
 * the linter", "wrong file, the config is in packages/core", "never push
 * directly to main", "use pnpm not npm") — never a plain imperative like
 * "push and create a pull request", "continue", or "write the
 * implementation plan". Anchored at the start of the (already-normalized)
 * text: these are openers, not phrases that can appear anywhere in a prompt. */
const CORRECTION_PATTERNS: RegExp[] = [
  /^no[, ]/i,
  /^don'?t\b/i,
  /^stop\s+\S*ing\b/i,
  /^actually\b/i,
  /^i told you\b/i,
  /^you didn'?t\b/i,
  /^wrong\b/i,
  /^never\b/i,
  /\buse\s+\S+\s+not\s+\S+/i,
];

export function isCorrectionShaped(normalized: string): boolean {
  const text = normalized.trim();
  if (!text) return false;
  return CORRECTION_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Deterministically reclassifies kind-"unknown" candidates whose signature
 * reads as unprompted user pushback as "correction" — no LLM involved.
 * Requires the same cross-session repetition floor as any other
 * deterministically-derived kind: count >= 3 across >= 2 sessions. Must run
 * after markLoops (classify.ts): candidates it already reclassified, and any
 * other already-classified kind (paste/answer/sequence/etc.), are left
 * untouched, so loops win ties by order.
 */
export function markCorrections(candidates: Candidate[]): void {
  for (const c of candidates) {
    if (c.kind !== "unknown") continue;
    if (c.count < CORRECTION_MIN_COUNT || c.sessions < CORRECTION_MIN_SESSIONS) continue;
    if (isCorrectionShaped(c.signature)) c.kind = "correction";
  }
}
