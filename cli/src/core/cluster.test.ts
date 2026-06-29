import { describe, it, expect } from "vitest";
import { normalize, similarity, cluster } from "./cluster.js";
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
});
