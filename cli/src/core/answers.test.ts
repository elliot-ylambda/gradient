import { describe, it, expect } from "vitest";
import { ANSWER_MAX_PAIRS, extractAnswerPairs, mineAnswerCandidates } from "./answers.js";
import type { DialogueTurn } from "./parse.js";

const d = (role: "user" | "assistant", text: string, sessionId = "s1", ts = "t"): DialogueTurn => ({
  role,
  text,
  sessionId,
  ts,
});

describe("extractAnswerPairs", () => {
  it("pairs a trailing question with the next short human answer", () => {
    const pairs = extractAnswerPairs([
      d("assistant", "I can use npm or pnpm. Which package manager should I use?"),
      d("user", "pnpm"),
    ]);
    expect(pairs).toEqual([{
      question: "I can use npm or pnpm. Which package manager should I use?",
      answer: "pnpm",
      sessionId: "s1",
      ts: "t",
    }]);
  });

  it("skips long answers, non-questions, injected answers, and cross-session pairs", () => {
    expect(extractAnswerPairs([d("assistant", "Which one?"), d("user", "x".repeat(100))])).toEqual([]);
    expect(extractAnswerPairs([d("assistant", "Done. All tests pass."), d("user", "1")])).toEqual([]);
    expect(extractAnswerPairs([d("assistant", "Which one?"), d("user", "<task-notification>x</task-notification>")])).toEqual([]);
    expect(extractAnswerPairs([d("assistant", "Which one?", "s1"), d("user", "2", "s2")])).toEqual([]);
  });

  it("rejects approvals, ordinals, credentials, and consequential questions", () => {
    expect(extractAnswerPairs([
      d("assistant", "Should I deploy to production?"), d("user", "yes"),
    ])).toEqual([]);
    expect(extractAnswerPairs([
      d("assistant", "Which formatting style do you prefer?"), d("user", "1"),
    ])).toEqual([]);
    expect(extractAnswerPairs([
      d("assistant", "Which password format do you prefer?"), d("user", "huntertwo"),
    ])).toEqual([]);
    expect(extractAnswerPairs([
      d("assistant", "Which output style do you prefer?"), d("user", "person@example.com"),
    ])).toEqual([]);
  });

  it("applies configured ignore patterns and a hard pair cap", () => {
    const dialogue = Array.from({ length: 10 }, (_, i) => [
      d("assistant", "Which package manager do you prefer?", `s${i}`),
      d("user", "pnpm", `s${i}`),
    ]).flat();
    expect(extractAnswerPairs(dialogue, [/^pnpm$/i])).toEqual([]);
    expect(extractAnswerPairs(dialogue, [], 2)).toHaveLength(2);
    expect(ANSWER_MAX_PAIRS).toBeLessThanOrEqual(1_500);
  });
});

describe("mineAnswerCandidates", () => {
  it("mines a semantic low-impact preference across distinct sessions", () => {
    const pairs = [
      { question: "Which package manager should I use?", answer: "pnpm", sessionId: "a", ts: "t" },
      { question: "Which package manager do you prefer?", answer: "pnpm", sessionId: "b", ts: "t" },
      { question: "Which package manager should this use?", answer: "pnpm", sessionId: "c", ts: "t" },
    ];
    const out = mineAnswerCandidates(pairs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "answer", count: 3, sessions: 3, confidence: "inferred" });
    expect(out[0].signature.startsWith("pnpm ← ")).toBe(true);
  });

  it("requires the support floor", () => {
    const pairs = [
      { question: "Which database style do you prefer?", answer: "postgres", sessionId: "a", ts: "t" },
      { question: "Which database style do you prefer?", answer: "postgres", sessionId: "b", ts: "t" },
    ];
    expect(mineAnswerCandidates(pairs)).toEqual([]);
  });

  it("requires support from at least two sessions", () => {
    const pairs = Array.from({ length: 3 }, () => ({
      question: "Which output style do you prefer?", answer: "concise", sessionId: "one", ts: "t",
    }));
    expect(mineAnswerCandidates(pairs)).toEqual([]);
  });
});
