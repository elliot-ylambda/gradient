import { describe, it, expect } from "vitest";
import {
  deriveDailyCadence,
  HOOK_MIN_COUNT,
  HOOK_MIN_SESSIONS,
  hookFromEvents,
  LOOP_MIN_RUN,
  LOOP_MIN_RUN_SESSIONS,
  markLoops,
  SCHEDULE_MIN_DAYS,
} from "./classify.js";
import { idFor } from "./detect.js";
import { cluster } from "./cluster.js";
import { annotateTemporal } from "./temporal.js";
import type { Candidate, CommandEvent, Turn } from "./types.js";

const u = (text: string, ts: string, sessionId = "s1"): Turn =>
  ({ ts, project: "p", role: "user", text, sessionId });

const cand = (overrides: Partial<Candidate> = {}): Candidate => ({
  kind: "unknown",
  signature: "continue",
  examples: ["continue"],
  count: 8,
  sessions: 3,
  sessionIds: ["s1", "s2", "s3"],
  occurrences: [],
  memberSignatures: ["continue"],
  confidence: "high",
  ...overrides,
});

describe("markLoops", () => {
  it("marks a kind-unknown candidate as loop when it meets both run thresholds", () => {
    const c = cand({ temporal: { maxRunLength: LOOP_MIN_RUN, runSessions: LOOP_MIN_RUN_SESSIONS, medianGapMinutes: 5, distinctDays: 1, spanDays: 0 } });
    markLoops([c]);
    expect(c.kind).toBe("loop");
  });

  it("leaves a candidate unmarked when maxRunLength is below the floor", () => {
    const c = cand({ temporal: { maxRunLength: LOOP_MIN_RUN - 1, runSessions: LOOP_MIN_RUN_SESSIONS, medianGapMinutes: 5, distinctDays: 1, spanDays: 0 } });
    markLoops([c]);
    expect(c.kind).toBe("unknown");
  });

  it("leaves a candidate unmarked when runSessions is below the floor", () => {
    const c = cand({ temporal: { maxRunLength: LOOP_MIN_RUN, runSessions: LOOP_MIN_RUN_SESSIONS - 1, medianGapMinutes: 5, distinctDays: 1, spanDays: 0 } });
    markLoops([c]);
    expect(c.kind).toBe("unknown");
  });

  it("does not touch a candidate with no temporal evidence", () => {
    const c = cand({ temporal: undefined });
    markLoops([c]);
    expect(c.kind).toBe("unknown");
  });

  it("never overrides an already-classified (non-unknown) kind", () => {
    const c = cand({ kind: "paste", temporal: { maxRunLength: 10, runSessions: 10, medianGapMinutes: 5, distinctDays: 1, spanDays: 0 } });
    markLoops([c]);
    expect(c.kind).toBe("paste");
  });

  it("sets cadence via deriveDailyCadence only once distinctDays crosses the schedule floor", () => {
    const below = cand({ temporal: { maxRunLength: LOOP_MIN_RUN, runSessions: LOOP_MIN_RUN_SESSIONS, medianGapMinutes: 5, distinctDays: SCHEDULE_MIN_DAYS - 1, spanDays: SCHEDULE_MIN_DAYS - 2 } });
    markLoops([below]);
    expect(below.kind).toBe("loop");
    expect(below.cadence).toBeUndefined();

    const atFloor = cand({ signature: "check the dashboard", temporal: { maxRunLength: LOOP_MIN_RUN, runSessions: LOOP_MIN_RUN_SESSIONS, medianGapMinutes: 5, distinctDays: SCHEDULE_MIN_DAYS, spanDays: SCHEDULE_MIN_DAYS - 1 } });
    markLoops([atFloor]);
    expect(atFloor.cadence).toBe(deriveDailyCadence(atFloor));
  });

  // Regression: a "continue"-style cluster with runs (maxRunLength 4, runSessions 3)
  // becomes loop-kind from real temporal annotation, with zero LLM involvement anywhere
  // in this module.
  it("marks a real 'continue'-style cluster as loop from annotateTemporal's output", () => {
    const turns = [
      u("continue", "2026-06-01T10:00:00Z", "s1"),
      u("continue", "2026-06-01T10:05:00Z", "s1"),
      u("continue", "2026-06-01T10:10:00Z", "s1"),
      u("continue", "2026-06-01T10:15:00Z", "s1"),
      u("continue", "2026-06-02T09:00:00Z", "s2"),
      u("continue", "2026-06-02T09:05:00Z", "s2"),
      u("continue", "2026-06-03T09:00:00Z", "s3"),
      u("continue", "2026-06-03T09:05:00Z", "s3"),
    ];
    const cands = cluster(turns, { minCount: 3 });
    annotateTemporal(turns, cands);
    const cont = cands.find(c => c.signature === "continue")!;
    expect(cont.temporal).toMatchObject({ maxRunLength: 4, runSessions: 3 });

    markLoops(cands);
    expect(cont.kind).toBe("loop");
  });
});

describe("deriveDailyCadence", () => {
  it("reads 'daily' when occurrences cover nearly every calendar day in the span", () => {
    const c = cand({ temporal: { maxRunLength: 1, runSessions: 0, medianGapMinutes: 0, distinctDays: 7, spanDays: 6 } });
    expect(deriveDailyCadence(c)).toBe("daily");
  });

  it("reads 'most weekdays' when occurrences skip a meaningful fraction of the span", () => {
    const c = cand({ temporal: { maxRunLength: 1, runSessions: 0, medianGapMinutes: 0, distinctDays: 10, spanDays: 13 } });
    expect(deriveDailyCadence(c)).toBe("most weekdays");
  });
});

const event = (command: string, sessionId: string): CommandEvent => ({
  ts: "2026-07-01T00:00:00Z",
  project: "p",
  sessionId,
  command,
});

describe("hookFromEvents", () => {
  it("returns null below the count floor", () => {
    const events = Array.from({ length: HOOK_MIN_COUNT - 1 }, (_, i) => event("/compact", `s${i % HOOK_MIN_SESSIONS}`));
    expect(hookFromEvents(events)).toBeNull();
  });

  it("returns null below the session floor even with enough total events", () => {
    const events = Array.from({ length: HOOK_MIN_COUNT + 5 }, (_, i) => event("/compact", `s${i % (HOOK_MIN_SESSIONS - 1)}`));
    expect(hookFromEvents(events)).toBeNull();
  });

  it("ignores non-compact commands when counting", () => {
    const compact = Array.from({ length: HOOK_MIN_COUNT }, (_, i) => event("/compact", `s${i % HOOK_MIN_SESSIONS}`));
    const other = Array.from({ length: 20 }, (_, i) => event("/model", `s${i}`));
    expect(hookFromEvents([...compact, ...other])).not.toBeNull();
    expect(hookFromEvents(other)).toBeNull();
  });

  it("returns the PreCompact/checkpoint hook suggestion with a stable id and event-derived evidence", () => {
    const events = Array.from({ length: HOOK_MIN_COUNT }, (_, i) => event("/compact", `s${i % HOOK_MIN_SESSIONS}`));
    const s = hookFromEvents(events);
    expect(s).not.toBeNull();
    expect(s!.id).toBe(idFor(["/compact"], "hook"));
    expect(s!.payload).toEqual({
      type: "hook",
      event: "PreCompact",
      subcommand: "checkpoint",
      description: "Save a private, redacted progress checkpoint before transcript compaction.",
    });
    expect(s!.evidence.count).toBe(HOOK_MIN_COUNT);
    expect(s!.evidence.sessions).toBe(HOOK_MIN_SESSIONS);
  });

  it("keeps the same id regardless of event ordering or which sessions appear first", () => {
    const events = Array.from({ length: HOOK_MIN_COUNT }, (_, i) => event("/compact", `s${i % HOOK_MIN_SESSIONS}`));
    const a = hookFromEvents(events);
    const b = hookFromEvents([...events].reverse());
    expect(a!.id).toBe(b!.id);
  });

  // Regression: 12 /compact events across 4 sessions produce the PreCompact hook
  // suggestion, independent of any LLM/backend (this function never takes one).
  it("12 /compact events across 4 sessions produce the PreCompact hook suggestion", () => {
    const events = [
      event("/compact", "s1"), event("/compact", "s1"), event("/compact", "s1"),
      event("/compact", "s2"), event("/compact", "s2"), event("/compact", "s2"),
      event("/compact", "s3"), event("/compact", "s3"), event("/compact", "s3"),
      event("/compact", "s4"), event("/compact", "s4"), event("/compact", "s4"),
    ];
    const s = hookFromEvents(events);
    expect(s).not.toBeNull();
    expect(s!.payload).toMatchObject({ type: "hook", event: "PreCompact", subcommand: "checkpoint" });
    expect(s!.evidence).toMatchObject({ count: 12, sessions: 4 });
  });
});
