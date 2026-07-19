import { describe, it, expect } from "vitest";
import { mineSequences, NUDGE_PROMPT_RE, SEQ_MIN_COUNT } from "./sequence.js";
import type { Turn } from "./types.js";

const turn = (sessionId: string, ts: string, text: string): Turn =>
  ({ ts, project: "p", role: "user", sessionId, text });

/** assign: normalized lookup over a fixed signature set. */
const assignOf = (sigs: string[]) => (text: string) => {
  const n = text.toLowerCase().trim();
  return sigs.includes(n) ? n : null;
};

/** One A→B occurrence per session s1..sN. */
function sessions(n: number, a = "review the spec", b = "write the plan"): Turn[] {
  return Array.from({ length: n }, (_, i) => [
    turn(`s${i}`, "2026-07-01T00:00:00Z", a),
    turn(`s${i}`, "2026-07-01T00:01:00Z", b),
  ]).flat();
}

describe("mineSequences", () => {
  const assign = assignOf(["review the spec", "write the plan", "push it"]);

  it("finds a chain at the support floor (3 occurrences, 2+ sessions)", () => {
    const { chains } = mineSequences(sessions(3), assign);
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({
      steps: ["review the spec", "write the plan"], count: 3,
    });
    expect(chains[0].sessions).toBeGreaterThanOrEqual(2);
    expect(chains[0].sessionIds.length).toBe(chains[0].sessions);
    expect(chains[0].occurrences).toHaveLength(chains[0].count);
    expect(chains[0].occurrences[0]).toEqual({ ts: "2026-07-01T00:01:00Z", sessionId: "s0" });
    expect(chains[0].examples[0]).toEqual(["review the spec", "write the plan"]);
  });

  it("drops pairs below the floor", () => {
    expect(mineSequences(sessions(SEQ_MIN_COUNT - 1), assign).chains).toHaveLength(0);
  });

  it("requires 2 distinct sessions even at 3 occurrences", () => {
    const oneSession = [
      turn("s1", "t1", "review the spec"), turn("s1", "t2", "write the plan"),
      turn("s1", "t3", "review the spec"), turn("s1", "t4", "write the plan"),
      turn("s1", "t5", "review the spec"), turn("s1", "t6", "write the plan"),
    ];
    expect(mineSequences(oneSession, assign).chains).toHaveLength(0);
  });

  it("nudges are transparent — adjacency bridges over them", () => {
    const withNudges = Array.from({ length: 3 }, (_, i) => [
      turn(`s${i}`, "t1", "review the spec"),
      turn(`s${i}`, "t2", "continue"),
      turn(`s${i}`, "t3", "write the plan"),
    ]).flat();
    expect(mineSequences(withNudges, assign).chains).toHaveLength(1);
  });

  it("unclustered prompts break chains", () => {
    const broken = Array.from({ length: 3 }, (_, i) => [
      turn(`s${i}`, "t1", "review the spec"),
      turn(`s${i}`, "t2", "something totally novel here"),
      turn(`s${i}`, "t3", "write the plan"),
    ]).flat();
    expect(mineSequences(broken, assign).chains).toHaveLength(0);
  });

  it("never bridges across sessions", () => {
    const alternating = Array.from({ length: 3 }, (_, i) => [
      turn(`a${i}`, "t1", "review the spec"),
      turn(`b${i}`, "t1", "write the plan"),
    ]).flat();
    expect(mineSequences(alternating, assign).chains).toHaveLength(0);
  });

  it("ignores same-signature repeats (A→A is not a chain)", () => {
    const rep = Array.from({ length: 3 }, (_, i) => [
      turn(`s${i}`, "t1", "review the spec"),
      turn(`s${i}`, "t2", "review the spec"),
    ]).flat();
    expect(mineSequences(rep, assign).chains).toHaveLength(0);
  });

  it("merges overlapping bigrams into one 3-step chain when sessions overlap", () => {
    const triple = Array.from({ length: 3 }, (_, i) => [
      turn(`s${i}`, "t1", "review the spec"),
      turn(`s${i}`, "t2", "write the plan"),
      turn(`s${i}`, "t3", "push it"),
    ]).flat();
    const { chains } = mineSequences(triple, assign);
    expect(chains).toHaveLength(1);
    expect(chains[0].steps).toEqual(["review the spec", "write the plan", "push it"]);
  });

  it("never fabricates a triple from two separately observed bigrams", () => {
    // Each session runs B→C early and A→B later. No session contains an
    // adjacent A→B→C occurrence, so a triple would have false provenance.
    const turns = Array.from({ length: 3 }, (_, i) => [
      turn(`s${i}`, "t1", "write the plan"),
      turn(`s${i}`, "t2", "push it"),
      turn(`s${i}`, "t3", "something totally novel here"),
      turn(`s${i}`, "t4", "review the spec"),
      turn(`s${i}`, "t5", "write the plan"),
    ]).flat();
    const { chains } = mineSequences(turns, assign);
    expect(chains.map(chain => chain.steps)).toEqual([
      ["write the plan", "push it"],
      ["review the spec", "write the plan"],
    ]);
    expect(chains.some(chain => chain.steps.length === 3)).toBe(false);
  });

  it("orders turns by timestamp within a session", () => {
    const shuffled = [
      turn("s1", "2026-07-01T00:05:00Z", "write the plan"),
      turn("s1", "2026-07-01T00:01:00Z", "review the spec"),
      turn("s2", "2026-07-01T00:05:00Z", "write the plan"),
      turn("s2", "2026-07-01T00:01:00Z", "review the spec"),
      turn("s3", "2026-07-01T00:05:00Z", "write the plan"),
      turn("s3", "2026-07-01T00:01:00Z", "review the spec"),
    ];
    expect(mineSequences(shuffled, assign).chains[0]?.steps)
      .toEqual(["review the spec", "write the plan"]);
  });
});

describe("NUDGE_PROMPT_RE", () => {
  it.each(["continue", "Continue.", "what's next?", "keep going", "ok", "proceed"])(
    "matches %s", t => expect(NUDGE_PROMPT_RE.test(t)).toBe(true));
  it.each(["continue the migration", "next step is tests", "1"])(
    "does not match %s", t => expect(NUDGE_PROMPT_RE.test(t)).toBe(false));
});
