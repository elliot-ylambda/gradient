import { describe, it, expect } from "vitest";
import { normalize, similarity, cluster, dedupeReplayedOccurrences } from "./cluster.js";
import type { Turn } from "./types.js";

const u = (text: string, sessionId = "s"): Turn => ({ ts: "t", project: "p", role: "user", text, sessionId });

describe("normalize", () => {
  it("lowercases, trims, collapses ws, strips trailing punctuation", () => {
    expect(normalize("  Push  the PR!! ")).toBe("push the pr");
  });
});

describe("similarity", () => {
  it("is 1 for identical, <1 for different", () => {
    expect(similarity("push the pr", "push the pr")).toBe(1);
    expect(similarity("push the pr", "delete the file")).toBeLessThan(0.3);
  });
});

describe("cluster", () => {
  it("groups exact repeats as high-confidence candidates", () => {
    const turns = [u("continue", "s1"), u("continue.", "s2"), u("Continue", "s3")];
    const cands = cluster(turns, { minCount: 3 });
    const top = cands[0];
    expect(top.count).toBe(3);
    expect(top.sessions).toBe(3);
    expect(top.confidence).toBe("high");
  });
  it("ignores patterns below minCount", () => {
    const turns = [u("rare prompt one"), u("rare prompt two")];
    expect(cluster(turns, { minCount: 3 }).length).toBe(0);
  });
  it("merges near-duplicates into an inferred candidate", () => {
    const turns = [
      u("push and create a pull request", "s1"),
      u("push and create a pull request then", "s2"),
      u("push and create the pull request", "s3"),
    ];
    const cands = cluster(turns, { minCount: 3, simThreshold: 0.5 });
    expect(cands.some(c => c.count >= 3 && c.confidence === "inferred")).toBe(true);
  });
  it("exposes the distinct session ids on each candidate", () => {
    const turns = [u("continue", "s1"), u("continue", "s1"), u("continue", "s2")];
    const top = cluster(turns, { minCount: 2 })[0];
    expect([...top.sessionIds].sort()).toEqual(["s1", "s2"]);
    expect(top.sessions).toBe(2);
  });
  it("still merges an in-threshold near-duplicate hidden among many distinct prompts", () => {
    const noise: Turn[] = Array.from({ length: 200 }, (_, i) => u(`unrelated distinct prompt ${i}`, `n${i}`));
    const trio = [
      u("push and create a pull request", "s1"),
      u("push and create a pull request then", "s2"),
      u("push and create the pull request", "s3"),
    ];
    const cands = cluster([...noise, ...trio], { minCount: 3, simThreshold: 0.5 });
    expect(cands.some(c => c.signature.includes("pull request") && c.count >= 3 && c.confidence === "inferred")).toBe(true);
  });

  it("records every assistant contributing to a merged habit", () => {
    const turns: Turn[] = [
      { ...u("ship it", "c1"), assistant: "claude-code" },
      { ...u("ship it", "codex:x1"), assistant: "codex" },
      { ...u("ship it", "codex:x2"), assistant: "codex" },
    ];
    expect(cluster(turns)[0].assistants).toEqual(["claude-code", "codex"]);
  });
  it("records one occurrence per turn with ts and sessionId", () => {
    const turns = [
      { ts: "2026-06-01T10:00:00Z", project: "p", role: "user" as const, text: "continue", sessionId: "s1" },
      { ts: "2026-06-01T10:05:00Z", project: "p", role: "user" as const, text: "continue", sessionId: "s1" },
      { ts: "2026-06-02T09:00:00Z", project: "p", role: "user" as const, text: "continue", sessionId: "s2" },
    ];
    const top = cluster(turns, { minCount: 3 })[0];
    expect(top.occurrences).toEqual([
      { ts: "2026-06-01T10:00:00Z", sessionId: "s1" },
      { ts: "2026-06-01T10:05:00Z", sessionId: "s1" },
      { ts: "2026-06-02T09:00:00Z", sessionId: "s2" },
    ]);
    expect(top.memberSignatures).toEqual(["continue"]);
  });
  it("unions occurrences and memberSignatures across a fuzzy merge", () => {
    const turns = [
      u("push and create a pull request", "s1"),
      u("push and create a pull request then", "s2"),
      u("push and create the pull request", "s3"),
    ];
    const cands = cluster(turns, { minCount: 3, simThreshold: 0.5 });
    const merged = cands.find(c => c.count >= 3 && c.confidence === "inferred")!;
    expect(merged.occurrences.length).toBe(3);
    expect(merged.memberSignatures.length).toBeGreaterThanOrEqual(2);
    expect(merged.memberSignatures).toContain("push and create a pull request");
  });
});

describe("dedupeReplayedOccurrences", () => {
  const candidate = (occurrences: { ts: string; sessionId: string }[]) => ({
    kind: "unknown" as const,
    signature: "sig",
    examples: ["x"],
    count: occurrences.length,
    sessions: new Set(occurrences.map(o => o.sessionId)).size,
    sessionIds: [...new Set(occurrences.map(o => o.sessionId))],
    occurrences,
    memberSignatures: [],
    confidence: "high" as const,
  });

  it("collapses the same instant replayed into several forked sessions", () => {
    // Observed shape: three sessions inherited one typed prompt verbatim.
    const [out] = dedupeReplayedOccurrences([candidate([
      { ts: "2026-07-19T00:07:09.199Z", sessionId: "a" },
      { ts: "2026-07-19T00:07:09.199Z", sessionId: "b" },
      { ts: "2026-07-19T00:07:09.199Z", sessionId: "c" },
    ])]);
    expect(out.count).toBe(1);
    expect(out.sessions).toBe(1);
    expect(out.occurrences).toHaveLength(1);
  });

  it("keeps genuinely separate sends, even seconds apart in different sessions", () => {
    const [out] = dedupeReplayedOccurrences([candidate([
      { ts: "2026-07-19T00:06:18.324Z", sessionId: "a" },
      { ts: "2026-07-19T00:06:42.562Z", sessionId: "b" },
    ])]);
    expect(out.count).toBe(2);
    expect(out.sessions).toBe(2);
  });

  it("keeps occurrences with no timestamp rather than guessing they are replays", () => {
    const [out] = dedupeReplayedOccurrences([candidate([
      { ts: "", sessionId: "a" },
      { ts: "", sessionId: "b" },
    ])]);
    expect(out.count).toBe(2);
  });

  it("returns the candidate untouched when nothing is duplicated", () => {
    const input = candidate([{ ts: "2026-07-19T00:00:00.000Z", sessionId: "a" }]);
    expect(dedupeReplayedOccurrences([input])[0]).toBe(input);
  });
});
