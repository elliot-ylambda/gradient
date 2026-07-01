import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stats } from "./stats.js";

async function seed(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-stats-"));
  await mkdir(join(dir, ".gradient"), { recursive: true });
  const suggestions = [
    { id: "aaa", name: "ship", title: "Ship", rationale: "r", evidence: { count: 9, sessions: 3 }, confidence: "high", payload: { type: "command", commandName: "ship", body: "x" } },
    { id: "bbb", name: "plan", title: "Plan", rationale: "r", evidence: { count: 4, sessions: 2 }, confidence: "inferred", payload: { type: "command", commandName: "plan", body: "y" } },
  ];
  const manifest = [{ name: "ship", type: "command", path: ".claude/commands/ship.md", createdAt: "2026-07-01", suggestionId: "aaa" }];
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify(suggestions));
  await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify(manifest));
  return dir;
}

describe("stats", () => {
  it("reports coverage and top patterns sorted by frequency", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-stats-home-"));
    const report = await stats(await seed(), { home });
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
    expect(report).toEqual({ total: 0, covered: 0, coveragePct: 0, sessionScanEnabled: false, patterns: [] });
  });

  it("reports sessionScanEnabled from config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-stats-cfg-"));
    const home = await mkdtemp(join(tmpdir(), "grad-stats-home-on-"));
    await mkdir(join(home, ".config", "gradient"), { recursive: true });
    await writeFile(join(home, ".config", "gradient", "config.json"), JSON.stringify({ scanOnSessionStart: true }));
    const report = await stats(dir, { home });
    expect(report.sessionScanEnabled).toBe(true);
  });
});
