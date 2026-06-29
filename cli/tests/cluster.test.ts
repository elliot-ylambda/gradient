import { describe, expect, it } from "vitest";
import { cluster } from "../src/core/cluster";
import { filterTurns } from "../src/core/filter";
import type { Turn } from "../src/types";

function userTurn(text: string, source = "a.jsonl"): Turn {
  return { ts: "2026-06-29T00:00:00Z", project: "demo", role: "user", source, text };
}

describe("filterTurns", () => {
  it("drops injected scaffolding but keeps genuine prompts", () => {
    const turns: Turn[] = [
      userTurn("ship it"),
      userTurn("<system-reminder>do the thing</system-reminder>"),
      userTurn("Caveat: this message was auto-generated"),
      userTurn("  "),
    ];
    const { prompts, removed } = filterTurns(turns);
    expect(prompts.map((p) => p.text)).toEqual(["ship it"]);
    expect(removed).toBe(3);
  });
});

describe("cluster", () => {
  it("groups normalized repeats, counts sessions, and ranks by frequency", () => {
    const turns: Turn[] = [
      userTurn("continue", "a.jsonl"),
      userTurn("Continue.", "a.jsonl"),
      userTurn("continue", "b.jsonl"),
      userTurn("write the implementation plan", "a.jsonl"),
      userTurn("write the implementation plan", "b.jsonl"),
      userTurn("one-off thought", "a.jsonl"),
    ];
    const { candidates, dropped } = cluster(turns, { minCount: 2 });

    expect(candidates[0]?.signature).toBe("continue");
    expect(candidates[0]?.count).toBe(3);
    expect(candidates[0]?.sessions).toBe(2);
    expect(candidates[0]?.kind).toBe("loop");

    const plan = candidates.find((c) => c.signature.startsWith("write the"));
    expect(plan?.kind).toBe("command");

    // the single "one-off thought" is below threshold and dropped (counted).
    expect(dropped).toBe(1);
  });
});
