import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { adoptionFromEvents, stats } from "./stats.js";
import { addEntry } from "../core/manifest.js";
import { appendAdoption } from "./recall.js";
import { suggestionsPath } from "./apply.js";

async function seed(home: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-stats-"));
  await mkdir(join(dir, ".gradient"), { recursive: true });
  const suggestions = [
    { id: "aaa", name: "ship", title: "Ship", rationale: "r", evidence: { count: 9, sessions: 3 }, confidence: "high", payload: { type: "command", commandName: "ship", body: "x" } },
    { id: "bbb", name: "plan", title: "Plan", rationale: "r", evidence: { count: 4, sessions: 2 }, confidence: "inferred", payload: { type: "command", commandName: "plan", body: "y" } },
  ];
  const manifest = [{ name: "ship", type: "command", path: ".claude/commands/ship.md", createdAt: "2026-07-01", suggestionId: "aaa" }];
  const path = suggestionsPath(dir, home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(suggestions));
  await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify(manifest));
  return dir;
}

describe("stats", () => {
  it("reports coverage and top patterns sorted by frequency", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-stats-home-"));
    const report = await stats(await seed(home), { home });
    expect(report.total).toBe(2);
    expect(report.covered).toBe(1);
    expect(report.coveragePct).toBe(50);
    expect(report.sessionScanEnabled).toBe(false);
    expect(report.patterns[0].name).toBe("ship");
    expect(report.patterns[0].covered).toBe(true);
    expect(report.patterns[1].covered).toBe(false);
  });

  it("reports zeros with no cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-stats-empty-"));
    const home = await mkdtemp(join(tmpdir(), "grad-stats-home-"));
    const report = await stats(dir, { home });
    expect(report).toEqual({
      total: 0,
      covered: 0,
      coveragePct: 0,
      sessionScanEnabled: false,
      patterns: [],
      adoption: [],
      capped: false,
    });
  });

  it("reports sessionScanEnabled from config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-stats-cfg-"));
    const home = await mkdtemp(join(tmpdir(), "grad-stats-home-on-"));
    await mkdir(join(home, ".config", "gradient"), { recursive: true });
    await writeFile(join(home, ".config", "gradient", "config.json"), JSON.stringify({ scanOnSessionStart: true }));
    const report = await stats(dir, { home });
    expect(report.sessionScanEnabled).toBe(true);
  });

  it("reports transcript uses, last use, and hinted retypes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-stats-adopt-"));
    const home = await mkdtemp(join(tmpdir(), "grad-stats-home-"));
    await addEntry(dir, {
      name: "ship",
      type: "skill",
      path: ".claude/skills/ship/SKILL.md",
      createdAt: "2026-06-15",
      suggestionId: "ship-id",
    });
    await appendAdoption(dir, {
      ts: "2026-07-01T00:00:00Z",
      artifact: "ship",
      similarity: 0.8,
      hinted: true,
    }, home);
    await appendAdoption(dir, {
      ts: "2026-07-02T00:00:00Z",
      artifact: "ship",
      similarity: 0.45,
      hinted: false,
    }, home);

    const report = await stats(dir, {
      home,
      now: Date.parse("2026-07-06T00:00:00Z"),
      collectFn: async () => ["transcript"],
      parseFn: async () => ({
        turns: [],
        events: [
          { ts: "2026-06-01T00:00:00Z", project: "p", sessionId: "s0", command: "/ship" },
          { ts: "2026-07-03T00:00:00Z", project: "p", sessionId: "s1", command: "/ship" },
        ],
      }),
    });
    expect(report.adoption).toEqual([expect.objectContaining({
      name: "ship",
      type: "skill",
      uses: 1,
      lastUsed: "2026-07-03T00:00:00Z",
      retypesCaught: 1,
      suggestRemoval: false,
    })]);
  });

  it("suggests removal at 30 unused days with no hinted retypes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-stats-unused-"));
    const home = await mkdtemp(join(tmpdir(), "grad-stats-home-"));
    await addEntry(dir, {
      name: "dead",
      type: "skill",
      path: ".claude/skills/dead/SKILL.md",
      createdAt: "2026-05-01",
      suggestionId: "dead-id",
    });
    const report = await stats(dir, {
      home,
      now: Date.parse("2026-05-31T00:00:00Z"),
      collectFn: async () => [],
      parseFn: async () => ({ turns: [], events: [] }),
    });
    expect(report.adoption[0]).toMatchObject({
      name: "dead",
      uses: 0,
      retypesCaught: 0,
      suggestRemoval: true,
    });
  });

  it("caps transcript files and turns before adoption analysis", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-stats-capped-"));
    const home = await mkdtemp(join(tmpdir(), "grad-stats-home-"));
    await addEntry(dir, {
      name: "ship", type: "skill", path: ".claude/skills/ship/SKILL.md",
      createdAt: "2026-06-15", suggestionId: "ship-id",
    });
    let parses = 0;
    const report = await stats(dir, {
      home,
      maxFiles: 1,
      maxTurns: 1,
      collectFn: async () => ["one", "two"],
      parseFn: async () => {
        parses++;
        return {
          turns: [
            { ts: "2026-07-01", project: "p", role: "user", sessionId: "s1", text: "first" },
            { ts: "2026-07-02", project: "p", role: "user", sessionId: "s2", text: "second" },
          ],
          events: [],
        };
      },
    });
    expect(parses).toBe(1);
    expect(report.capped).toBe(true);
  });

  it("uses enabled Codex rollouts and reports a dual-target artifact once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-stats-codex-"));
    const home = await mkdtemp(join(tmpdir(), "grad-stats-home-"));
    await mkdir(join(home, ".config", "gradient"), { recursive: true });
    await writeFile(join(home, ".config", "gradient", "config.json"), JSON.stringify({ targets: ["codex"] }));
    await addEntry(dir, {
      name: "ship", type: "skill", target: "codex", path: ".agents/skills/ship/SKILL.md",
      createdAt: "2026-06-15", suggestionId: "ship-id",
    });
    const report = await stats(dir, {
      home,
      collectFn: async () => { throw new Error("Claude collection must stay disabled"); },
      collectCodexFn: async () => ["codex"],
      parseCodexFn: async () => [{
        ts: "2026-07-03T00:00:00Z", project: "p", role: "user", sessionId: "s1",
        text: "<command-name>/ship</command-name>", assistant: "codex",
      }],
    });
    // Codex parsing is untouched and yields no CommandEvents (real Codex CLI
    // transcripts carry no `<command-name>` tags), so codex-target usage
    // can't be counted from transcripts today — 0 uses, not a regression.
    expect(report.adoption).toEqual([expect.objectContaining({ name: "ship", uses: 0 })]);

    const dual = await adoptionFromEvents(dir, [], { manifest: [
      { name: "ship", type: "skill", path: ".claude/skills/ship/SKILL.md", createdAt: "2026-06-15", suggestionId: "ship-id" },
      { name: "ship", type: "skill", target: "codex", path: ".agents/skills/ship/SKILL.md", createdAt: "2026-06-15", suggestionId: "ship-id" },
    ], home });
    expect(dual).toHaveLength(1);
  });
});
