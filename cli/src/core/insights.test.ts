import { describe, it, expect } from "vitest";
import {
  isNudgeText,
  computeMetrics,
  sumAutopilotAvoided,
  buildRecommendations,
  buildCostRows,
  renderInsightsHtml,
} from "./insights.js";
import type { CommandEvent, Turn } from "./types.js";
import { saveState, stateDir } from "./state.js";
import { mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const t = (text: string): Turn => ({
  ts: "2026-07-01T00:00:00Z",
  project: "p",
  role: "user",
  sessionId: "s",
  text,
});

describe("isNudgeText", () => {
  it.each(["continue", "Continue.", "what's next?", "lgtm", "Looks good.", "yes", "ship it"])(
    "recognizes %s",
    text => expect(isNudgeText(text)).toBe(true),
  );

  it.each(["continue the refactor in auth.ts", "yesterday's build failed"])(
    "rejects %s",
    text => expect(isNudgeText(text)).toBe(false),
  );
});

const event = (command: string): CommandEvent => ({
  ts: "2026-07-01T00:00:00Z",
  project: "p",
  sessionId: "s",
  command,
});

describe("computeMetrics", () => {
  it("counts each metric from a mixed transcript, command events supplied separately", () => {
    const turns = [
      t("continue"),
      t("fix the login bug"),
      t("[Request interrupted by user]"),
      t("This session is being continued from a previous conversation."),
      t("<task-notification>x</task-notification>"),
      t(`make dev\n${"error: boom\n".repeat(40)}`),
    ];
    const events = [event("/compact"), event("/model"), event("/effort")];
    expect(computeMetrics(turns, events)).toEqual({
      prompts: 3,
      nudges: 1,
      interrupts: 1,
      continuations: 1,
      notifications: 1,
      compacts: 1,
      modelSwitches: 1,
      effortSwitches: 1,
      errorPastes: 1,
    });
  });

  it("honors configured injected-prompt patterns", () => {
    expect(computeMetrics([t("site injector: continue")], [], [/^site injector:/i]).prompts).toBe(0);
  });
});

describe("sumAutopilotAvoided", () => {
  it("sums recent counts across session state files and returns zero without a state dir", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-ins-"));
    await saveState("a", { count: 3, attempts: 3, lastFingerprint: "", stoodDown: false, log: [] }, home);
    await saveState("b", { count: 2, attempts: 2, lastFingerprint: "", stoodDown: false, log: [] }, home);
    expect(await sumAutopilotAvoided(home)).toBe(5);
    expect(await sumAutopilotAvoided(await mkdtemp(join(tmpdir(), "grad-emp-")))).toBe(0);
  });

  it("does not count stale state older than seven days", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-stale-"));
    await saveState("old", { count: 99, attempts: 99, lastFingerprint: "", stoodDown: false, log: [] }, home);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(stateDir(home), "old.json"), old, old);
    expect(await sumAutopilotAvoided(home)).toBe(0);
  });
});

describe("buildRecommendations", () => {
  const metrics = {
    prompts: 100,
    nudges: 30,
    interrupts: 25,
    continuations: 10,
    notifications: 0,
    compacts: 5,
    modelSwitches: 15,
    effortSwitches: 0,
    errorPastes: 12,
  };

  it("routes each hot metric to a concrete action", () => {
    const recommendations = buildRecommendations(metrics, {
      autopilotMode: undefined,
      avoided: 0,
      recallInstalled: false,
      unusedArtifacts: ["dead"],
    });
    const all = recommendations.map(recommendation => recommendation.line).join("\n");
    expect(all).toContain("gradient autopilot nudge");
    expect(all).toContain("gradient continuity on");
    expect(all).toContain("gradient recall on");
    expect(all).toContain("gradient remove dead");
    expect(all).toContain("defaultModel");
    expect(all).toContain("fewer-permission-prompts");
  });

  it("reports avoided nudges when autopilot is on", () => {
    const recommendations = buildRecommendations(metrics, {
      autopilotMode: "nudge",
      avoided: 7,
      recallInstalled: true,
      unusedArtifacts: [],
    });
    expect(recommendations.map(recommendation => recommendation.line).join("\n")).toContain("7 nudge(s) avoided");
  });

  it("routes effort churn even without model switches", () => {
    const recommendations = buildRecommendations(
      { ...metrics, modelSwitches: 0, effortSwitches: 12 },
      { autopilotMode: "off", avoided: 0, recallInstalled: true, unusedArtifacts: [] },
    );
    expect(recommendations.map(recommendation => recommendation.line).join("\n")).toContain("defaultModel");
  });
});

describe("buildCostRows", () => {
  it("uses recorded turn usage and falls back to chars/4", () => {
    const nudge = { ...t("continue"), usageTokens: 120 };
    const continuation = t("This session is being continued from a previous conversation.");
    const rows = buildCostRows([nudge, continuation]);
    expect(rows.find(row => row.metric === "nudges")).toMatchObject({ tokens: 120, prompts: 1 });
    expect(rows.find(row => row.metric === "continuations")?.tokens)
      .toBe(Math.ceil((continuation.text?.length ?? 0) / 4));
    expect(rows.map(row => row.line).join("\n")).toContain("≈");
  });

  it("counts only paste keys repeated to the detector support floor", () => {
    const repeated = t(`make test\n${"error: boom\n".repeat(40)}`);
    expect(buildCostRows([repeated, { ...repeated }, { ...repeated }]))
      .toEqual([expect.objectContaining({ metric: "pastes", prompts: 3 })]);
    expect(buildCostRows([repeated])).toEqual([]);
  });

  it("hides the section entirely when no attributable habits exist", () => {
    expect(buildCostRows([t("implement the parser")])).toEqual([]);
  });
});

describe("renderInsightsHtml", () => {
  const report = {
    label: "project scope",
    avoided: 2,
    metrics: {
      prompts: 10,
      nudges: 3,
      interrupts: 1,
      continuations: 2,
      notifications: 0,
      compacts: 4,
      modelSwitches: 0,
      effortSwitches: 0,
      errorPastes: 1,
    },
    recommendations: [{ metric: "nudges", line: "try <gradient autopilot nudge> & friends" }],
    costs: [{ metric: "nudges" as const, tokens: 123, prompts: 3, line: "≈123 tokens · 3 nudges" }],
    toolActivity: { failureLoops: 2, postEditRituals: 1 },
  };

  it("is self-contained and escapes dynamic content", () => {
    const html = renderInsightsHtml(report);
    expect(html).toContain("<style>");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("&lt;gradient autopilot nudge&gt; &amp; friends");
    expect(html).toContain("project scope");
    expect(html).toContain("cost of unautomated habits");
    expect(html).toContain("≈123 tokens");
    expect(html).toContain("in-session failure loops");
    expect(html).toContain("post-edit rituals");
  });
});
