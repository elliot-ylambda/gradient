import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insights, writeInsightsHtml } from "./insights.js";
import type { Turn } from "../core/types.js";

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
      { collectFn: async () => ["f"], parseFn: async () => nudgeTurns },
    );
    expect(report.metrics.nudges).toBe(12);
    expect(report.recommendations.map(item => item.line).join("\n")).toContain("gradient autopilot nudge");
    expect(report.label).toContain("project");
  });

  it("runs on an empty project without crashing", async () => {
    const report = await insights(
      { projectDir: dir, home },
      { collectFn: async () => [], parseFn: async () => [] },
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
        parseFn: async () => [],
      },
    );
    expect(captured).toEqual([expect.objectContaining({ scope: "all", sinceDays: 7 })]);
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
          return [];
        },
      },
    );
    expect({ collects, parses }).toEqual({ collects: 1, parses: 1 });
    expect(report.recommendations.map(item => item.line)).toContain("unused 30d+: gradient remove dead");
  });

  it("writes the HTML report inside .gradient", async () => {
    const report = await insights(
      { projectDir: dir, home },
      { collectFn: async () => [], parseFn: async () => [] },
    );
    const path = await writeInsightsHtml(dir, report);
    expect(path).toBe(join(dir, ".gradient", "insights.html"));
    expect(await readFile(path, "utf8")).toContain("gradient insights");
  });
});
