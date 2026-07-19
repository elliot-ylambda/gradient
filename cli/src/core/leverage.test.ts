import { describe, it, expect } from "vitest";
import { estMinutesSavedPerMonth, candidateLeverage, CORRECTION_S } from "./leverage.js";
import type { Candidate } from "./types.js";

describe("estMinutesSavedPerMonth", () => {
  it("anchor: 12 occurrences of a 66-char prompt over 30 days is 7 min/month", () => {
    expect(estMinutesSavedPerMonth({ count: 12, chars: 66, spanDays: 30, kind: "command" })).toBe(7);
  });

  it("scales with count and chars for command-shaped observations", () => {
    expect(estMinutesSavedPerMonth({ count: 24, chars: 66, spanDays: 30, kind: "command" })).toBe(14);
  });

  it("floors the extrapolation span at a week so a one-day burst isn't read as a daily habit", () => {
    const oneDay = estMinutesSavedPerMonth({ count: 3, chars: 66, spanDays: 1, kind: "command" });
    const oneWeek = estMinutesSavedPerMonth({ count: 3, chars: 66, spanDays: 7, kind: "command" });
    expect(oneDay).toBe(oneWeek);
  });

  it("uses a flat correction cost for rule-shaped observations, independent of prompt length", () => {
    const short = estMinutesSavedPerMonth({ count: 5, chars: 5, spanDays: 30, kind: "rule" });
    const long = estMinutesSavedPerMonth({ count: 5, chars: 500, spanDays: 30, kind: "rule" });
    expect(short).toBe(long);
    expect(short).toBe(Math.round(5 * (CORRECTION_S / 60) * (30 / 30)));
  });
});

describe("candidateLeverage", () => {
  const anchor = (overrides: Partial<Candidate> = {}): Candidate => ({
    kind: "unknown",
    signature: "x".repeat(66),
    examples: ["x".repeat(66)],
    count: 12,
    sessions: 12,
    sessionIds: Array.from({ length: 12 }, (_, i) => `s${i}`),
    occurrences: [
      { ts: "2026-06-01T00:00:00Z", sessionId: "s0" },
      { ts: "2026-07-01T00:00:00Z", sessionId: "s1" },
    ],
    memberSignatures: [],
    confidence: "high",
    ...overrides,
  });

  it("reproduces the anchor from mean example length and occurrence span", () => {
    expect(candidateLeverage(anchor())).toBe(7);
  });

  it("maps answer candidates to the flat rule cost regardless of example length", () => {
    const short = candidateLeverage(anchor({ kind: "answer", examples: ["a"] }));
    const long = candidateLeverage(anchor({ kind: "answer", examples: ["a".repeat(500)] }));
    expect(short).toBe(long);
  });

  it("maps every non-answer kind to the command (typing-cost) formula", () => {
    const unknown = candidateLeverage(anchor({ kind: "unknown" }));
    const paste = candidateLeverage(anchor({ kind: "paste" }));
    const sequence = candidateLeverage(anchor({ kind: "sequence" }));
    expect(paste).toBe(unknown);
    expect(sequence).toBe(unknown);
  });

  it("ranks a frequent short prompt below an even-more-frequent one, count as tiebreak signal", () => {
    const frequent = candidateLeverage(anchor({ count: 24 }));
    const rare = candidateLeverage(anchor({ count: 12 }));
    expect(frequent).toBeGreaterThan(rare);
  });
});
