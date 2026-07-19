import type { Candidate, CommandEvent, Suggestion } from "./types.js";
import { idFor } from "./detect.js";

/** Longest consecutive same-cluster run within a session required before a
 * kind-"unknown" candidate is deterministically reclassified as a loop. */
export const LOOP_MIN_RUN = 3;
/** Sessions containing a run of length >= 2 required alongside LOOP_MIN_RUN. */
export const LOOP_MIN_RUN_SESSIONS = 2;
/** Distinct calendar days of occurrence required before a loop also gets a
 * derived cadence (schedule-shaped, not just repeated). */
export const SCHEDULE_MIN_DAYS = 5;
/** `/compact` events required before hookFromEvents proposes the checkpoint hook. */
export const HOOK_MIN_COUNT = 10;
/** Distinct sessions the `/compact` events must span. */
export const HOOK_MIN_SESSIONS = 3;

/** "daily" once occurrences cover nearly every calendar day of the span,
 * else "most weekdays" for a sparser but still schedule-shaped cadence.
 * Ratio uses spanDays + 1 (calendar days inclusive of both endpoints) so a
 * candidate seen on every day of its span reads as exactly 1.0. */
export function deriveDailyCadence(c: Candidate): string {
  const t = c.temporal;
  if (!t) return "daily";
  const ratio = t.distinctDays / (t.spanDays + 1);
  return ratio >= 0.8 ? "daily" : "most weekdays";
}

/**
 * Deterministically reclassifies kind-"unknown" candidates whose temporal
 * evidence (set by annotateTemporal) shows a recurring same-session run as
 * "loop" — no LLM involved. Candidates already classified as something else
 * (paste/answer/sequence/etc.) are left untouched. When the loop's
 * occurrences are also schedule-shaped (enough distinct days), a cadence is
 * derived and attached.
 */
export function markLoops(candidates: Candidate[]): void {
  for (const c of candidates) {
    if (c.kind !== "unknown") continue;
    const t = c.temporal;
    if (!t) continue;
    if (t.maxRunLength >= LOOP_MIN_RUN && t.runSessions >= LOOP_MIN_RUN_SESSIONS) {
      c.kind = "loop";
      if (t.distinctDays >= SCHEDULE_MIN_DAYS) c.cadence = deriveDailyCadence(c);
    }
  }
}

/**
 * Deterministically proposes the house PreCompact/checkpoint hook from raw
 * `/compact` command-event counts — no LLM involved, and independent of
 * whether a backend is available at all. Returns null until both floors are
 * crossed.
 */
export function hookFromEvents(events: CommandEvent[]): Suggestion | null {
  const compacts = events.filter(e => e.command.replace(/^\//, "").toLowerCase() === "compact");
  const sessions = new Set(compacts.map(e => e.sessionId)).size;
  if (compacts.length < HOOK_MIN_COUNT || sessions < HOOK_MIN_SESSIONS) return null;

  return {
    id: idFor(["/compact"], "hook"),
    name: "checkpoint-before-compaction",
    title: "Save a checkpoint before context compaction",
    rationale:
      `Observed ${compacts.length} /compact invocation(s) across ${sessions} sessions; ` +
      "a PreCompact hook can save a private, redacted progress checkpoint first.",
    evidence: { count: compacts.length, sessions, assistants: ["claude-code"] },
    confidence: "high",
    payload: {
      type: "hook",
      event: "PreCompact",
      subcommand: "checkpoint",
      description: "Save a private, redacted progress checkpoint before transcript compaction.",
    },
  };
}
