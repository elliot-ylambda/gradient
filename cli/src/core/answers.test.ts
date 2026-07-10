import { describe, it, expect } from "vitest";
import { extractAnswerPairs, mineAnswerCandidates } from "./answers.js";
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
});

describe("mineAnswerCandidates", () => {
  it("mines a repeated answer to similar option questions", () => {
    const pairs = [
      { question: "Which approach should I take? 1) minimal 2) full", answer: "1", sessionId: "a", ts: "t" },
      { question: "Which approach do you prefer? 1) quick 2) thorough", answer: "1", sessionId: "b", ts: "t" },
      { question: "Which approach works best here? 1) x 2) y", answer: "1", sessionId: "c", ts: "t" },
      { question: "Should I delete the old branch?", answer: "1", sessionId: "d", ts: "t" },
    ];
    const out = mineAnswerCandidates(pairs);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "answer", count: 3, sessions: 3, confidence: "inferred" });
    expect(out[0].signature.startsWith("1 ← ")).toBe(true);
  });

  it("requires the support floor", () => {
    const pairs = [
      { question: "Which db?", answer: "postgres", sessionId: "a", ts: "t" },
      { question: "Which db?", answer: "postgres", sessionId: "b", ts: "t" },
    ];
    expect(mineAnswerCandidates(pairs)).toEqual([]);
  });
});
