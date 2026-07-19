import { beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insights, writeInsightsHtml } from "./insights.js";
import type { CommandEvent, Turn } from "../core/types.js";

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-insc-"));
  home = await mkdtemp(join(tmpdir(), "grad-insh-"));
});

const nudgeTurns: Turn[] = Array.from({ length: 12 }, (_, index) => ({
  ts: "2026-07-01T00:00:00Z",
  project: "p",
  role: "user",
  sessionId: `s${index}`,
  text: "continue",
}));

describe("insights", () => {
  it("assembles metrics and recommendations for project scope", async () => {
    const report = await insights(
      { projectDir: dir, home },
      { collectFn: async () => ["f"], parseFn: async () => ({ turns: nudgeTurns, events: [] }) },
    );
    expect(report.metrics.nudges).toBe(12);
    expect(report.recommendations.map(item => item.line).join("\n")).toContain("gradient autopilot nudge");
    expect(report.label).toContain("project");
  });

  it("runs on an empty project without crashing", async () => {
    const report = await insights(
      { projectDir: dir, home },
      { collectFn: async () => [], parseFn: async () => ({ turns: [], events: [] }) },
    );
    expect(report.metrics.prompts).toBe(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it("widens user scope with the seven-day default window", async () => {
    const captured: unknown[] = [];
    await insights(
      { projectDir: dir, user: true, home },
      {
        collectFn: async options => {
          captured.push(options);
          return [];
        },
        parseFn: async () => ({ turns: [], events: [] }),
      },
    );
    expect(captured).toEqual([expect.objectContaining({ scope: "all", sinceDays: 7 })]);
  });

  it("filters old turns inside a recently touched user-scope transcript", async () => {
    const report = await insights(
      { projectDir: dir, user: true, home, now: Date.parse("2026-07-09T00:00:00Z") },
      {
        collectFn: async () => ["recently-touched.jsonl"],
        parseFn: async () => ({
          turns: [
            { ts: "2025-01-01T00:00:00Z", project: "p", role: "user", sessionId: "old", text: "continue" },
            { ts: "2026-07-08T00:00:00Z", project: "p", role: "user", sessionId: "new", text: "fix tests" },
          ],
          events: [],
        }),
      },
    );
    expect(report.metrics).toMatchObject({ prompts: 1, nudges: 0 });
  });

  it("reuses the parsed corpus for adoption instead of collecting twice", async () => {
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify([{
      name: "dead",
      type: "skill",
      path: ".claude/skills/dead/SKILL.md",
      createdAt: "2020-01-01",
      suggestionId: "dead-id",
    }]));
    let collects = 0;
    let parses = 0;
    const report = await insights(
      { projectDir: dir, home },
      {
        collectFn: async () => {
          collects++;
          return ["f"];
        },
        parseFn: async () => {
          parses++;
          return { turns: [], events: [] };
        },
      },
    );
    expect({ collects, parses }).toEqual({ collects: 1, parses: 1 });
    expect(report.recommendations.map(item => item.line)).toContain("unused 30d+: gradient remove dead");
  });

  it("writes the HTML report inside .gradient", async () => {
    const report = await insights(
      { projectDir: dir, home },
      { collectFn: async () => [], parseFn: async () => ({ turns: [], events: [] }) },
    );
    const path = await writeInsightsHtml(dir, report);
    expect(path).toBe(join(dir, ".gradient", "insights.html"));
    expect(await readFile(path, "utf8")).toContain("gradient insights");
  });

  it("refuses a symlinked HTML output directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "grad-victim-"));
    await symlink(outside, join(dir, ".gradient"));
    const report = await insights(
      { projectDir: dir, home },
      { collectFn: async () => [], parseFn: async () => ({ turns: [], events: [] }) },
    );
    await expect(writeInsightsHtml(dir, report)).rejects.toThrow(/symlink/);
    await expect(access(join(outside, "insights.html"))).rejects.toThrow();
  });

  it("combines enabled Claude Code and Codex turns in metrics and token costs", async () => {
    const report = await insights(
      { projectDir: dir, home },
      {
        config: { targets: ["claude-code", "codex"] },
        collectFn: async () => ["claude"],
        collectCodexFn: async () => ["codex"],
        parseFn: async () => ({ turns: [{ ...nudgeTurns[0], assistant: "claude-code", usageTokens: 100 }], events: [] }),
        parseCodexFn: async () => [{ ...nudgeTurns[1], assistant: "codex", usageTokens: 50 }],
      },
    );
    expect(report.metrics.nudges).toBe(2);
    expect(report.costs).toEqual([
      expect.objectContaining({ metric: "nudges", prompts: 2, tokens: 150 }),
    ]);
  });

  it("threads parsed command events into compact/model/effort metrics and adoption", async () => {
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify([{
      name: "ship",
      type: "skill",
      path: ".claude/skills/ship/SKILL.md",
      createdAt: "2020-01-01",
      suggestionId: "ship-id",
    }]));
    const events: CommandEvent[] = [
      { ts: "2026-07-01T00:00:00Z", project: "p", sessionId: "s1", command: "/compact" },
      { ts: "2026-07-01T00:01:00Z", project: "p", sessionId: "s1", command: "/model" },
      { ts: "2026-07-01T00:02:00Z", project: "p", sessionId: "s1", command: "/ship" },
    ];
    const report = await insights(
      { projectDir: dir, home },
      { collectFn: async () => ["f"], parseFn: async () => ({ turns: [], events }) },
    );
    expect(report.metrics).toMatchObject({ compacts: 1, modelSwitches: 1, effortSwitches: 0 });
    expect(report.recommendations.map(item => item.line)).not.toContain("unused 30d+: gradient remove ship");
  });
});
