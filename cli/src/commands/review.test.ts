import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { review } from "./review.js";
import { isNudge } from "../core/playbook.js";
import type { Suggestion } from "../core/types.js";
import { saveConfig } from "../config.js";
import { suggestionsPath } from "./apply.js";

const mk = (name: string): Suggestion => ({
  id: `id-${name}`, name, title: "t", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "high",
  payload: { type: "command", commandName: name, body: "do it" },
});

async function seed(dir: string, home: string, names: string[]) {
  const path = suggestionsPath(dir, home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(names.map(mk)));
}

describe("review", () => {
  it("approves selectively and stops on quit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir, home, ["ship", "plan", "next"]);
    const answers: Record<string, "approve" | "skip" | "quit"> = { ship: "approve", plan: "skip", next: "quit" };
    const applied = await review(dir, async (s) => answers[s.name], { home });
    expect(applied.map(a => a.suggestion.name)).toEqual(["ship"]);
  });

  it("honors the configured command emit target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir, home, ["ship"]);
    await saveConfig({ emitTarget: "command" }, home);
    const [applied] = await review(dir, async () => "approve", { home });
    expect(applied.written).toBe(join(dir, ".claude", "commands", "ship.md"));
  });

  it("previews the exact rendered artifact before approval", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir, home, ["ship"]);
    let preview = "";
    await review(dir, async (_s, _i, _n, rendered) => {
      preview = rendered;
      return "skip";
    }, { home });
    expect(preview).toContain(".claude/skills/ship/SKILL.md");
    expect(preview).toContain("do it");
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
