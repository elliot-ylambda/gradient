import type { Candidate } from "./types.js";
import { spanDays } from "./temporal.js";

/** Assumed typing speed (chars/sec), used to estimate how long a human would
 * spend retyping an observed prompt by hand instead of invoking an automation. */
export const TYPING_CPS = 3.3;
/** Fixed per-occurrence overhead: switching context, reading the response, confirming. */
export const ROUND_TRIP_S = 15;
/** Flat cost of one correction cycle for a preference/rule-shaped observation
 * (re-stating a preference the assistant should already know), independent of length. */
export const CORRECTION_S = 60;

export type LeverageKind = "command" | "loop" | "hook" | "rule";

export function perOccurrenceSeconds(input: { chars: number; kind: LeverageKind }): number {
  if (input.kind === "rule") return CORRECTION_S;
  // A loop replaces the round trip needed to ask for continuation; unlike a
  // reusable command/hook, it does not claim to save retyping an instruction.
  if (input.kind === "loop") return ROUND_TRIP_S;
  const chars = Number.isFinite(input.chars) && input.chars > 0 ? input.chars : 0;
  return chars / TYPING_CPS + ROUND_TRIP_S;
}

/**
 * Minutes/month a user would save automating an observed pattern, extrapolated
 * from how often it actually occurred over the observed span. The span is
 * floored at a week so a handful of occurrences seen within a single day isn't
 * read as an implausible daily habit.
 */
export function estMinutesSavedPerMonth(
  input: { count: number; chars: number; spanDays: number; kind: LeverageKind },
): number {
  const seconds = perOccurrenceSeconds(input);
  const monthly = input.count * (seconds / 60) * (30 / Math.max(input.spanDays, 7));
  return Math.round(monthly);
}

export function meanLength(strings: string[]): number {
  return strings.length ? strings.reduce((sum, s) => sum + s.length, 0) / strings.length : 0;
}

/**
 * Ranks a pre-classification Candidate by estimated leverage, for ordering the
 * detect window before the LLM (or the degrade path) assigns a payload type.
 * Deterministically classified loops use the round-trip-only estimate;
 * answer/correction/instruction candidates are rule-shaped; everything else
 * uses the command typing-cost estimate.
 */
export function candidateLeverage(c: Candidate): number {
  return estMinutesSavedPerMonth({
    count: c.count,
    chars: meanLength(c.examples),
    spanDays: spanDays(c.occurrences),
    kind: c.kind === "loop"
      ? "loop"
      : c.kind === "answer" || c.kind === "correction" || c.kind === "instruction"
        ? "rule"
        : "command",
  });
}
