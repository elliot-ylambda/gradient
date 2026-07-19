import type { Candidate, CommandEvent, Suggestion } from "./types.js";
import { idFor } from "./detect.js";
import { commandKey } from "./command.js";
import { estMinutesSavedPerMonth } from "./leverage.js";
import { spanDays } from "./temporal.js";

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

function dailyCoverage(c: Candidate): number {
  const temporal = c.temporal;
  if (!temporal) return 0;
  return temporal.distinctDays / Math.max(1, Math.floor(temporal.spanDays) + 1);
}

/** Deterministic cron at the median observed UTC hour. The schedule is never
 * invented when no parseable occurrence timestamp exists. */
export function deriveDailyCadence(c: Candidate): string | undefined {
  const hours = c.occurrences
    .map(occurrence => Date.parse(occurrence.ts))
    .filter(Number.isFinite)
    .map(timestamp => new Date(timestamp).getUTCHours())
    .sort((left, right) => left - right);
  if (hours.length === 0) return undefined;
  const middle = Math.floor(hours.length / 2);
  const median = hours.length % 2 === 1
    ? hours[middle]
    : Math.round((hours[middle - 1] + hours[middle]) / 2);
  return `0 ${median} * * *`;
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
    const repeatedRun = t.maxRunLength >= LOOP_MIN_RUN && t.runSessions >= LOOP_MIN_RUN_SESSIONS;
    const dailySchedule = t.distinctDays >= SCHEDULE_MIN_DAYS && dailyCoverage(c) >= 0.8;
    if (repeatedRun || dailySchedule) {
      c.kind = "loop";
      if (dailySchedule) {
        const cadence = deriveDailyCadence(c);
        if (cadence) c.cadence = cadence;
      }
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
  const compacts = events.filter(e => commandKey(e.command) === "compact");
  const sessions = new Set(compacts.map(e => e.sessionId)).size;
  if (compacts.length < HOOK_MIN_COUNT || sessions < HOOK_MIN_SESSIONS) return null;

  return {
    id: idFor(["/compact"], "hook"),
    name: "checkpoint-before-compaction",
    title: "Save a checkpoint before context compaction",
    rationale:
      `Measured ${compacts.length} /compact invocation(s) across ${sessions} sessions; ` +
      "a PreCompact hook can save a private, redacted progress checkpoint first.",
    evidence: {
      count: compacts.length,
      sessions,
      assistants: ["claude-code"],
      estMinutesSavedPerMonth: estMinutesSavedPerMonth({
        count: compacts.length,
        chars: "/compact".length,
        spanDays: spanDays(compacts),
        kind: "hook",
      }),
    },
    confidence: "high",
    sourceSignatures: ["/compact"],
    payload: {
      type: "hook",
      event: "PreCompact",
      subcommand: "checkpoint",
      description: "Save a private, redacted progress checkpoint before transcript compaction.",
    },
  };
}
