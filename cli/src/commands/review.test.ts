import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { review } from "./review.js";
import { isNudge } from "../core/playbook.js";
import type { Suggestion } from "../core/types.js";

const mk = (name: string): Suggestion => ({
  id: `id-${name}`, name, title: "t", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "high",
  payload: { type: "command", commandName: name, body: "do it" },
});

async function seed(dir: string, names: string[]) {
  await mkdir(join(dir, ".gradient"), { recursive: true });
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify(names.map(mk)));
}

describe("review", () => {
  it("approves selectively and stops on quit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await seed(dir, ["ship", "plan", "next"]);
    const answers: Record<string, "approve" | "skip" | "quit"> = { ship: "approve", plan: "skip", next: "quit" };
    const applied = await review(dir, async (s) => answers[s.name]);
    expect(applied.map(a => a.suggestion.name)).toEqual(["ship"]);
  });
});

describe("nudge hint", () => {
  it("cadence-less loop suggestions are flagged for the autopilot hint", () => {
    const s = {
      id: "i", name: "continue", title: "t", rationale: "r",
      evidence: { count: 150, sessions: 44 }, confidence: "high" as const,
      payload: { type: "loop" as const, instruction: "continue until done" },
    };
    expect(isNudge(s)).toBe(true);
  });
});

describe("reviewJson", () => {
  it("prints the cached suggestions as JSON", async () => {
    const { reviewJson } = await import("./review.js");
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const SUGGESTION = {
      id: "abc123def4", name: "fix-push", title: "Fix push", rationale: "r",
      evidence: { count: 3, sessions: 2 }, confidence: "high" as const,
      payload: { type: "command" as const, commandName: "fix-push", body: "do the thing" },
    };
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([SUGGESTION]));
    const out = JSON.parse(await reviewJson(dir));
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("abc123def4");
    expect(out[0].payload.type).toBe("command");
  });
  it("prints [] when no cache exists", async () => {
    const { reviewJson } = await import("./review.js");
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    expect(JSON.parse(await reviewJson(dir))).toEqual([]);
  });
});
