import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClarify, review } from "./review.js";
import { loadSuggestions, saveSuggestions } from "./apply.js";
import { isNudge } from "../core/playbook.js";
import type { Suggestion } from "../core/types.js";
import { saveConfig } from "../config.js";

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
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir, ["ship", "plan", "next"]);
    const answers: Record<string, "approve" | "skip" | "quit"> = { ship: "approve", plan: "skip", next: "quit" };
    const applied = await review(dir, async (s) => answers[s.name], { home });
    expect(applied.map(a => a.suggestion.name)).toEqual(["ship"]);
  });

  it("honors the configured command emit target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir, ["ship"]);
    await saveConfig({ emitTarget: "command" }, home);
    const [applied] = await review(dir, async () => "approve", { home });
    expect(applied.written).toBe(join(dir, ".claude", "commands", "ship.md"));
  });

  it("fans approval out to every configured assistant target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir, ["ship"]);
    await saveConfig({ targets: ["claude-code", "codex"] }, home);
    const [applied] = await review(dir, async () => "approve", { home });
    expect(applied.writes.map(write => write.target)).toEqual(["claude-code", "codex"]);
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

const flagged: Suggestion = {
  id: "c1",
  name: "lgtm",
  title: "LGTM approval",
  rationale: "Ambiguous intent",
  evidence: { count: 3, sessions: 2 },
  confidence: "flagged",
  payload: { type: "command", commandName: "lgtm", body: "ambiguous" },
  clarify: {
    question: "Acknowledge or merge?",
    options: [
      { label: "acknowledge", body: "Treat as sign-off only." },
      { label: "merge", body: "Approve and merge once checks pass." },
    ],
  },
};

describe("clarification resolution", () => {
  it("swaps the body, promotes confidence, records the choice, and keeps identity", () => {
    const resolved = resolveClarify(flagged, "merge");
    expect(resolved).toMatchObject({
      id: "c1",
      confidence: "high",
      payload: { type: "command", body: "Approve and merge once checks pass." },
      clarify: { chosen: "merge" },
    });
  });

  it("rejects unknown choices, non-command payloads, and already-resolved suggestions", () => {
    expect(resolveClarify(flagged, "nope")).toBeNull();
    expect(resolveClarify({
      ...flagged,
      payload: { type: "loop", instruction: "continue" },
    }, "merge")).toBeNull();
    expect(resolveClarify({
      ...flagged,
      clarify: { ...flagged.clarify!, chosen: "merge" },
    }, "acknowledge")).toBeNull();
  });

  it("resolves, persists, then applies the chosen body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-clarify-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await saveSuggestions(dir, [flagged]);

    const applied = await review(dir, async () => "approve", {
      home,
      clarifier: async () => "merge",
    });

    expect(applied).toHaveLength(1);
    expect(applied[0].suggestion.payload).toMatchObject({
      type: "command",
      body: "Approve and merge once checks pass.",
    });
    const [persisted] = await loadSuggestions(dir);
    expect(persisted.clarify?.chosen).toBe("merge");
    expect(persisted.confidence).toBe("high");
  });

  it("declining the choice keeps the suggestion flagged and unapplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-clarify-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await saveSuggestions(dir, [flagged]);
    let approvalPrompted = false;

    const applied = await review(dir, async () => {
      approvalPrompted = true;
      return "approve";
    }, { home, clarifier: async () => null });

    expect(applied).toEqual([]);
    expect(approvalPrompted).toBe(false);
    const [persisted] = await loadSuggestions(dir);
    expect(persisted.confidence).toBe("flagged");
    expect(persisted.clarify?.chosen).toBeUndefined();
  });

  it("does not ask again after a clarification was resolved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-clarify-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const resolved = resolveClarify(flagged, "merge")!;
    await saveSuggestions(dir, [resolved]);
    let clarificationCalls = 0;

    await review(dir, async () => "skip", {
      home,
      clarifier: async () => {
        clarificationCalls++;
        return null;
      },
    });

    expect(clarificationCalls).toBe(0);
  });
});
