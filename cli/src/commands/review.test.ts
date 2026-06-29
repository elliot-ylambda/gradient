import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { review } from "./review.js";
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
