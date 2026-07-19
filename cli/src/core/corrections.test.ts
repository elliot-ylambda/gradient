import { describe, it, expect } from "vitest";
import {
  CORRECTION_MIN_COUNT,
  CORRECTION_MIN_SESSIONS,
  isCorrectionShaped,
  markCorrections,
} from "./corrections.js";
import type { Candidate } from "./types.js";

describe("isCorrectionShaped", () => {
  const positive = [
    "no, use pnpm",
    "don't add comments",
    "stop adding comments to everything",
    "actually use the existing helper",
    "i told you to run the tests first",
    "you didn't run the linter",
    "wrong file, the config is in packages/core",
    "never push directly to main",
    "use pnpm not npm",
  ];

  it.each(positive)("matches the correction-shaped prompt %j", text => {
    expect(isCorrectionShaped(text)).toBe(true);
  });

  const negative = [
    "push and create a pull request",
    "continue",
    "write the implementation plan",
  ];

  it.each(negative)("does not match the plain imperative %j", text => {
    expect(isCorrectionShaped(text)).toBe(false);
  });

  it("is false for empty or whitespace-only text", () => {
    expect(isCorrectionShaped("")).toBe(false);
    expect(isCorrectionShaped("   ")).toBe(false);
  });
});

describe("markCorrections", () => {
  const cand = (overrides: Partial<Candidate> = {}): Candidate => ({
    kind: "unknown",
    signature: "don't add comments",
    examples: ["don't add comments"],
    count: CORRECTION_MIN_COUNT,
    sessions: CORRECTION_MIN_SESSIONS,
    sessionIds: ["s1", "s2"],
    occurrences: [],
    memberSignatures: ["don't add comments"],
    confidence: "inferred",
    ...overrides,
  });

  it("marks a kind-unknown correction-shaped candidate meeting both thresholds", () => {
    const c = cand();
    markCorrections([c]);
    expect(c.kind).toBe("correction");
  });

  it("leaves it unmarked when count is below the floor", () => {
    const c = cand({ count: CORRECTION_MIN_COUNT - 1 });
    markCorrections([c]);
    expect(c.kind).toBe("unknown");
  });

  it("leaves it unmarked when sessions is below the floor", () => {
    const c = cand({ sessions: CORRECTION_MIN_SESSIONS - 1 });
    markCorrections([c]);
    expect(c.kind).toBe("unknown");
  });

  it("leaves a non-correction-shaped signature unmarked even above both floors", () => {
    const c = cand({
      signature: "push and create a pull request",
      examples: ["push and create a pull request"],
      count: 10,
      sessions: 10,
    });
    markCorrections([c]);
    expect(c.kind).toBe("unknown");
  });

  it("never overrides an already-classified kind (loops win ties by order)", () => {
    const c = cand({ kind: "loop" });
    markCorrections([c]);
    expect(c.kind).toBe("loop");
  });

  it("never overrides an already-classified answer or paste kind", () => {
    const answer = cand({ kind: "answer" });
    const paste = cand({ kind: "paste" });
    markCorrections([answer, paste]);
    expect(answer.kind).toBe("answer");
    expect(paste.kind).toBe("paste");
  });
});
