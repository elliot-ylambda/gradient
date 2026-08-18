import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, featureStatus, REPORT_MAX_SUGGESTIONS } from "./report.js";
import { renderReport } from "./report-render.js";
import { displayCommand } from "../core/hookBinary.js";
import { saveSuggestions } from "./apply.js";
import { FEATURES } from "./features.js";
import type { InsightsReport } from "./insights.js";
import type { Suggestion } from "../core/types.js";

const emptyInsights = (over: Partial<InsightsReport> = {}): InsightsReport => ({
  label: "project scope · all history",
  avoided: 0,
  capped: false,
  metrics: {
    prompts: 0, nudges: 0, interrupts: 0, continuations: 0, notifications: 0,
    compacts: 0, modelSwitches: 0, effortSwitches: 0, errorPastes: 0,
  },
  toolActivity: { failureLoops: 0, postEditRituals: 0 },
  recommendations: [],
  costs: [],
  adoption: [],
  ...over,
});

const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: "s1", name: "n", title: "t", rationale: "r",
  evidence: { count: 1, sessions: 1 },
  confidence: "high",
  payload: { type: "command", commandName: "n", body: "b" },
  ...over,
});

const deps = (over: Record<string, unknown> = {}) => ({
  insightsFn: async () => emptyInsights(),
  boardShowFn: async () => "gradient board — 0 other sessions in this repo",
  loadSuggestionsFn: async () => [],
  ...over,
});

describe("buildReport", () => {
  it("hides suggestions that are already applied or dismissed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-report-"));
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify([
      { name: "ship", type: "skill", path: ".claude/skills/ship/SKILL.md", createdAt: "2026-06-01", suggestionId: "applied" },
    ]));
    const report = await buildReport(dir, deps({
      loadSuggestionsFn: async () => [
        suggestion({ id: "applied", name: "ship" }),
        suggestion({ id: "open", name: "open" }),
      ],
    }) as never);
    expect(report.pending.map(s => s.name)).toEqual(["open"]);
  });

  it("puts measured suggestions above prompt-inferred ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-report-tier-"));
    const report = await buildReport(dir, deps({
      loadSuggestionsFn: async () => [
        suggestion({ id: "a", name: "guessed", evidence: { count: 99, sessions: 9 } }),
        suggestion({ id: "b", name: "counted", evidence: { count: 2, sessions: 1, measured: true } }),
      ],
    }) as never);
    // Count loses to evidence class: 99 repetitions of a sentence are still an
    // interpretation, and 2 counted tool failures are still a measurement.
    expect(report.pending.map(s => s.name)).toEqual(["counted", "guessed"]);
  });

  it("shows at most a few suggestions and leaves the rest to scan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-report-cap-"));
    const report = await buildReport(dir, deps({
      loadSuggestionsFn: async () => Array.from({ length: 10 }, (_, i) =>
        suggestion({ id: `s${i}`, name: `n${i}`, evidence: { count: 10 - i, sessions: 1 } })),
    }) as never);
    expect(report.pending).toHaveLength(REPORT_MAX_SUGGESTIONS);
  });

  it("survives a project that is not a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-report-nogit-"));
    const report = await buildReport(dir, deps({
      boardShowFn: async () => { throw new Error("gradient board requires a git repository"); },
    }) as never);
    expect(report.board).toBeNull();
  });

  it("reads real cached suggestions when no override is given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-report-real-"));
    const home = await mkdtemp(join(tmpdir(), "grad-report-home-"));
    await saveSuggestions(dir, [suggestion({
      id: "cached", name: "cached",
      payload: { type: "command", commandName: "cached", body: "b" },
    })], home);
    const report = await buildReport(dir, {
      home,
      insightsFn: (async () => emptyInsights()) as never,
      boardShowFn: (async () => "") as never,
    });
    expect(report.pending.map(s => s.name)).toEqual(["cached"]);
  });
});

describe("renderReport", () => {
  /**
   * The report writes advice as `gradient on continuity` because spelling the
   * runner out on every line buries the numbers those lines exist to report.
   * That is only honest if the report says, once, what `gradient` is — nothing
   * puts it on PATH.
   */
  it("says what `gradient` is, since nothing else on the machine does", () => {
    const out = renderReport(base).join("\n");
    expect(out).toContain(`gradient = ${displayCommand()}`);
    expect(displayCommand()).not.toBe("gradient");
  });

  const base = {
    insights: emptyInsights({ recommendations: [{ metric: "m", line: "do the thing" }] }),
    adoption: [],
    pending: [],
    features: [{ name: "continuity", on: true }, { name: "board", on: false }],
    board: null,
  };

  it("renders feature state and the next actions", () => {
    const out = renderReport(base).join("\n");
    expect(out).toContain("features:");
    expect(out).toContain("continuity");
    expect(out).toContain("do the thing");
  });

  it("omits a board that contains only this session", () => {
    const out = renderReport({ ...base, board: "gradient board — 0 other sessions in this repo" }).join("\n");
    expect(out).not.toContain("other sessions\n");
  });

  it("shows the board once there is something to see", () => {
    const out = renderReport({
      ...base,
      board: "gradient board — 1 other session in this repo\n  feat/x  editing parse.ts",
    }).join("\n");
    expect(out).toContain("other sessions");
    expect(out).toContain("editing parse.ts");
  });

  it("marks a measured suggestion in the pending list", () => {
    const out = renderReport({
      ...base,
      pending: [suggestion({ name: "counted", evidence: { count: 3, sessions: 2, measured: true } })],
    }).join("\n");
    expect(out).toContain("counted");
    expect(out).toContain("measured");
  });

  it("neutralizes control characters in artifact and suggestion names", () => {
    const out = renderReport({
      ...base,
      adoption: [{
        name: "evil[2Jname", type: "skill", createdAt: "2026-06-01",
        uses: 0, realizedMinutesSaved: 0, suggestRemoval: true,
      }],
    }).join("\n");
    expect(out).not.toContain("[2J");
  });
});

describe("the feature rows", () => {
  /**
   * The report is where people read which features are on, so every name it
   * prints has to be a name `gradient on|off` accepts. The fourth row said
   * `session-scan` — the config's word for the behaviour, not a feature — so
   * the report told users about a switch and then answered
   * `unknown feature: session-scan` when they reached for it.
   *
   * Written against the whole list rather than the one bad row: the two lists
   * are maintained in different files, and nothing else holds them together.
   */
  it("print only names that gradient on|off accepts", async () => {
    const rows = await featureStatus(process.cwd(), {}, undefined);
    expect(rows.length).toBe(FEATURES.length);
    for (const row of rows) {
      expect(FEATURES, `report row \`${row.name}\` is not a feature`).toContain(row.name);
    }
    // ...and every feature has a row, so none can be silently unreportable.
    for (const feature of FEATURES) {
      expect(rows.map(row => row.name)).toContain(feature);
    }
  });
});
