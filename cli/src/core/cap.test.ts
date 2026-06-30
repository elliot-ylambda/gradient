import { describe, it, expect } from "vitest";
import { capByRecency } from "./cap.js";
import type { Turn } from "./types.js";

function turn(ts: string, text: string): Turn {
  return { ts, project: "p", role: "user", text, sessionId: "s" };
}

describe("capByRecency", () => {
  it("returns everything unchanged when under the cap", () => {
    const ps = [turn("2026-01-01", "a"), turn("2026-01-02", "b")];
    expect(capByRecency(ps, 10)).toEqual({ kept: ps, dropped: 0 });
  });

  it("keeps the most recent prompts and reports the drop count", () => {
    const ps = [turn("2026-01-01", "old"), turn("2026-01-03", "new"), turn("2026-01-02", "mid")];
    const { kept, dropped } = capByRecency(ps, 2);
    expect(dropped).toBe(1);
    expect(kept.map(t => t.text)).toEqual(["new", "mid"]); // newest first, oldest dropped
  });

  it("treats max <= 0 as no cap", () => {
    const ps = [turn("2026-01-01", "a")];
    expect(capByRecency(ps, 0)).toEqual({ kept: ps, dropped: 0 });
  });
});
