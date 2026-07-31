import { describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs, main, posixShellQuote, RETIRED } from "./cli.js";
import { spawnDetached } from "./core/spawn.js";
import { insights, writeInsightsHtml } from "./commands/insights.js";
import { recap } from "./commands/recap.js";
import { bundleCommand } from "./commands/bundle.js";
import { notify } from "./commands/notify.js";
import { saveSuggestions } from "./commands/apply.js";
import { clarifiedWorkflowBody } from "./core/detect.js";
import { scan } from "./commands/scan.js";
import { sessionStart } from "./commands/sessionStart.js";
import { boardDigest, boardRefresh, boardShow } from "./commands/board.js";
import { buildReport } from "./commands/report.js";
import { setFeature } from "./commands/features.js";

vi.mock("./commands/scan.js", () => ({ scan: vi.fn(async () => []) }));
vi.mock("./core/spawn.js", () => ({ spawnDetached: vi.fn() }));
vi.mock("./commands/sessionStart.js", () => ({ sessionStart: vi.fn(async () => {}) }));
vi.mock("./commands/report.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./commands/report.js")>()),
  buildReport: vi.fn(async () => ({
    insights: {
      label: "project scope · all history",
      avoided: 0,
      capped: false,
      metrics: {
        prompts: 12, nudges: 11, interrupts: 2, continuations: 3, notifications: 0,
        compacts: 4, modelSwitches: 1, effortSwitches: 2, errorPastes: 5,
      },
      toolActivity: { failureLoops: 2, postEditRituals: 1 },
      recommendations: [{ metric: "nudges", line: "try: gradient on autopilot" }],
      costs: [],
      adoption: [],
    },
    adoption: [{
      name: "dead", type: "skill", createdAt: "2026-05-01",
      uses: 0, lastUsed: undefined, realizedMinutesSaved: 0, suggestRemoval: true,
    }],
    pending: [],
    features: [{ name: "continuity", on: true }, { name: "autopilot", on: false }],
    board: null,
  })),
}));
vi.mock("./commands/features.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./commands/features.js")>()),
  setFeature: vi.fn(async (name: string, on: boolean) => ({
    on, settingsPath: "/repo/.claude/settings.local.json", detail: on ? `${name} detail` : undefined,
  })),
}));
vi.mock("./commands/insights.js", () => ({
  insights: vi.fn(async () => ({
    label: "project scope · all history",
    avoided: 0,
    metrics: {
      prompts: 12,
      nudges: 11,
      interrupts: 2,
      continuations: 3,
      notifications: 0,
      compacts: 4,
      modelSwitches: 1,
      effortSwitches: 2,
      errorPastes: 5,
    },
    toolActivity: { failureLoops: 2, postEditRituals: 1 },
    recommendations: [{ metric: "nudges", line: "try: gradient on autopilot" }],
    costs: [{ metric: "nudges", tokens: 120, prompts: 11, line: "≈120 tokens · 11 nudge prompts" }],
  })),
  writeInsightsHtml: vi.fn(async () => "/repo/.gradient/insights.html"),
}));
vi.mock("./commands/continuity.js", () => ({
  continuityStatus: vi.fn(async () => ({ checkpoint: true, recap: true })),
  setContinuity: vi.fn(async (on: boolean) => ({ on, settingsPath: "/repo/.claude/settings.local.json" })),
}));
vi.mock("./commands/recap.js", () => ({
  recap: vi.fn(async () => null),
}));
vi.mock("./commands/bundle.js", () => ({
  bundleCommand: vi.fn(async () => ({
    dir: "/repo/.gradient/bundle/team-toolkit",
    files: [
      "/repo/.gradient/bundle/team-toolkit/.claude-plugin/plugin.json",
      "/repo/.gradient/bundle/team-toolkit/skills/ship/SKILL.md",
    ],
    skipped: ["a-loop"],
  })),
}));
vi.mock("./commands/notify.js", () => ({
  notify: vi.fn(async () => {}),
}));
vi.mock("./commands/board.js", () => ({
  boardDigest: vi.fn(async () => null),
  boardRefresh: vi.fn(async () => null),
  boardShow: vi.fn(async () => "gradient board — 0 other sessions in this repo"),
  setBoard: vi.fn(async (on: boolean) => ({
    on,
    settingsPath: "/repo/.claude/settings.local.json",
  })),
}));

describe("parseCliArgs", () => {
  it("parses command, flags, and positionals", () => {
    const r = parseCliArgs(["scan", "--all", "--since", "7d"]);
    expect(r.command).toBe("scan");
    expect(r.flags.all).toBe(true);
    expect(r.flags.since).toBe("7d");
  });

  it("parses positionals after command", () => {
    const r = parseCliArgs(["apply", "my-suggestion", "other"]);
    expect(r.command).toBe("apply");
    expect(r.positionals).toEqual(["my-suggestion", "other"]);
  });

  it("parses --limit flag", () => {
    const r = parseCliArgs(["scan", "--limit", "10"]);
    expect(r.flags.limit).toBe("10");
  });

  it("parses the --dry-run flag", () => {
    const r = parseCliArgs(["migrate", "--dry-run"]);
    expect(r.command).toBe("migrate");
    expect(r.flags["dry-run"]).toBe(true);
  });

  it("parses the insights --html flag", () => {
    expect(parseCliArgs(["insights", "--html"]).flags.html).toBe(true);
  });

  it("parses the init assistant target", () => {
    expect(parseCliArgs(["init", "--target", "both"]).flags.target).toBe("both");
  });

  it("returns empty command for empty argv", () => {
    const r = parseCliArgs([]);
    expect(r.command).toBe("");
    expect(r.positionals).toEqual([]);
  });
});

describe("unknown options", () => {
  it("returns 2 and names the bad option instead of throwing", async () => {
    const logs: string[] = [];
    const code = await main(["scan", "--bogus"], { log: (m) => logs.push(m) });
    expect(code).toBe(2);
    expect(logs.join("\n")).toContain("--bogus");
  });

  it("never leaks a Node parse_args stack trace", async () => {
    const logs: string[] = [];
    await main(["review", "--json"], { log: (m) => logs.push(m) });
    expect(logs.join("\n")).not.toContain("ERR_PARSE_ARGS_UNKNOWN_OPTION");
    expect(logs.join("\n")).not.toContain("node:internal");
  });

  it("main rejects nothing — an unknown option resolves to an exit code", async () => {
    await expect(main(["scan", "--nope"], { log: () => {} })).resolves.toBe(2);
  });
});

describe("--version / --help", () => {
  it.each([["--version"], ["-v"]])("%s prints the bare version and exits 0", async (flag) => {
    const logs: string[] = [];
    const code = await main([flag], { log: (m) => logs.push(m) });
    expect(code).toBe(0);
    // Bare and unadorned so `gradient --version` is scriptable — no banner, no ANSI.
    expect(logs.join("\n").trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each([["--help"], ["-h"]])("%s prints usage and exits 0, not 2", async (flag) => {
    const logs: string[] = [];
    const code = await main([flag], { log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
  });

  it("does not treat --version as an unknown command", async () => {
    const logs: string[] = [];
    await main(["--version"], { log: (m) => logs.push(m) });
    expect(logs.join("\n")).not.toContain("unknown command");
  });
});

describe("main", () => {
  // The report is what gradient is for, so a bare invocation prints it in a
  // pipe as much as in a terminal. Help is what `help` is for.
  it("prints the report for a bare invocation regardless of TTY", async () => {
    for (const isTTY of [true, false]) {
      vi.mocked(buildReport).mockClear();
      const logs: string[] = [];
      expect(await main([], { isTTY, home: "/home", log: line => logs.push(line) })).toBe(0);
      expect(vi.mocked(buildReport)).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ home: "/home" }));
      expect(logs.join("\n")).toContain("prompts");
      expect(logs.join("\n")).not.toContain("Usage:");
    }
  });

  it("reports a report failure like any other command instead of crashing", async () => {
    vi.mocked(buildReport).mockRejectedValueOnce(new Error("corrupt manifest"));
    const logs: string[] = [];
    const code = await main([], { isTTY: true, log: (m) => logs.push(m) });
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("gradient: corrupt manifest");
  });

  it("explicit help always prints usage even on an interactive terminal", async () => {
    vi.mocked(buildReport).mockClear();
    const logs: string[] = [];
    expect(await main(["help"], { isTTY: true, log: line => logs.push(line) })).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
    expect(vi.mocked(buildReport)).not.toHaveBeenCalled();
  });

  it("returns 2 for an unknown command", async () => {
    const logs: string[] = [];
    const code = await main(["wat"], { log: (m) => logs.push(m) });
    expect(code).toBe(2);
  });

  it("includes help text in unknown command output", async () => {
    const logs: string[] = [];
    await main(["unknowncmd"], { log: (m) => logs.push(m) });
    const output = logs.join("\n");
    expect(output).toContain("gradient");
    expect(output).toContain("unknowncmd");
  });

  it("scan --detach does not forward --detach to child (fork-bomb guard)", async () => {
    vi.mocked(spawnDetached).mockClear();
    const code = await main(["scan", "--detach", "--all"], { log: () => {} });
    expect(code).toBe(0);
    expect(vi.mocked(spawnDetached)).toHaveBeenCalledTimes(1);
    const forwardedArgs = vi.mocked(spawnDetached).mock.calls[0][0] as string[];
    expect(forwardedArgs).not.toContain("--detach");
    expect(forwardedArgs).toContain("scan");
    expect(forwardedArgs).toContain("--all");
  });

  it("dispatches the session-start hook target with fail-open dependencies", async () => {
    vi.mocked(sessionStart).mockClear();
    const logs: string[] = [];
    expect(await main(["session-start"], { home: "/home", log: line => logs.push(line) })).toBe(0);
    expect(vi.mocked(sessionStart)).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      home: "/home",
      write: expect.any(Function),
      spawnDetachedFn: spawnDetached,
    }));
  });

  it("never shows the minutes-saved estimate, which is derived from the count it inflates with", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-cli-home-"));
    vi.mocked(scan).mockResolvedValueOnce([{
      id: "a", name: "ship", title: "Ship things", rationale: "r", confidence: "high",
      evidence: { count: 5, sessions: 3, estMinutesSavedPerMonth: 20 },
      payload: { type: "command", commandName: "ship", body: "b" },
    }]);
    const logs: string[] = [];
    const code = await main(["scan", "--no-review"], { home, log: m => logs.push(m) });
    expect(code).toBe(0);
    const output = logs.join("\n");
    expect(output).not.toContain("20m/mo");
    // The evidence that is actually counted stays visible.
    expect(output).toContain("seen 5×");
    expect(output).toContain("3 session(s)");
  });

  it("separates measured (tool-event) suggestions from prompt-inferred ones", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-cli-home-"));
    vi.mocked(scan).mockResolvedValueOnce([
      {
        id: "a", name: "ship", title: "Ship things", rationale: "r", confidence: "high",
        evidence: { count: 5, sessions: 3 },
        payload: { type: "command", commandName: "ship", body: "b" },
      },
      {
        id: "b", name: "notify-when-waiting", title: "Ping when idle", rationale: "r", confidence: "high",
        evidence: { count: 30, sessions: 23 },
        payload: { type: "hook", event: "Notification", subcommand: "notify" },
      },
    ]);
    const logs: string[] = [];
    expect(await main(["scan", "--no-review"], { home, log: m => logs.push(m) })).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("measured");
    expect(output).toContain("possible");
    // The measured tier is printed first, so the hook leads.
    expect(output.indexOf("notify-when-waiting")).toBeLessThan(output.indexOf("ship"));
  });

  it("omits the minutes-saved suffix for a suggestion cached before the estimate existed", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-cli-home-"));
    vi.mocked(scan).mockResolvedValueOnce([{
      id: "a", name: "ship", title: "Ship things", rationale: "r", confidence: "high",
      evidence: { count: 5, sessions: 3 },
      payload: { type: "command", commandName: "ship", body: "b" },
    }]);
    const logs: string[] = [];
    const code = await main(["scan", "--no-review"], { home, log: m => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.join("\n")).not.toContain("m/mo");
  });
});

describe("autopilot dispatch", () => {
  it("help text lists the single consent verb, not the four it replaced", async () => {
    const lines: string[] = [];
    await main(["help"], { log: s => lines.push(s) });
    const help = lines.join("\n");
    expect(help).toContain("gradient on|off <feature>");
    for (const retired of ["gradient autopilot", "gradient continuity", "gradient board", "gradient stats",
      "gradient list", "gradient explain", "gradient migrate", "gradient mirror", "gradient insights"]) {
      expect(help).not.toContain(retired);
    }
  });

  it("still routes the old grammar and says where it went", async () => {
    const lines: string[] = [];
    vi.mocked(setFeature).mockClear();
    expect(await main(["autopilot", "nudge"], { home: "/home", log: s => lines.push(s) })).toBe(0);
    expect(vi.mocked(setFeature)).toHaveBeenCalledWith("autopilot", true, expect.any(String), { home: "/home" });
    expect(lines.join("\n")).toContain("gradient autopilot nudge is now gradient on autopilot");
  });

  it("rejects an unknown autopilot action", async () => {
    const lines: string[] = [];
    const code = await main(["autopilot", "sideways"], { log: s => lines.push(s) });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("unknown autopilot action");
  });
});

describe("on|off dispatch", () => {
  it("toggles each background feature through one verb", async () => {
    for (const feature of ["continuity", "autopilot", "board", "session-scan"]) {
      vi.mocked(setFeature).mockClear();
      const lines: string[] = [];
      expect(await main(["on", feature], { home: "/home", log: s => lines.push(s) })).toBe(0);
      expect(vi.mocked(setFeature)).toHaveBeenCalledWith(feature, true, expect.any(String), { home: "/home" });
      expect(lines.join("\n")).toContain(`${feature} on`);

      expect(await main(["off", feature], { home: "/home", log: s => lines.push(s) })).toBe(0);
      expect(vi.mocked(setFeature)).toHaveBeenLastCalledWith(feature, false, expect.any(String), { home: "/home" });
      expect(lines.join("\n")).toContain(`${feature} off`);
    }
  });

  // Both directions report where the change landed, and report it the same way:
  // the state on one line, the settings path indented under it. Asserting the
  // shape rather than the punctuation is deliberate — the previous test pinned
  // a literal "off:" that only one of the two branches produced.
  it("reports the settings path on its own line, whichever way it toggled", async () => {
    for (const direction of ["on", "off"]) {
      const lines: string[] = [];
      expect(await main([direction, "continuity"], { home: "/home", log: s => lines.push(s) })).toBe(0);
      expect(lines[0]).toContain(`continuity ${direction}`);
      expect(lines[0]).not.toContain("settings.local.json");
      expect(lines[1]).toMatch(/^ {2}\S*settings\.local\.json$/);
    }
  });

  it("names the available features when given a bad one or none", async () => {
    for (const argv of [["on"], ["on", "telepathy"]]) {
      const lines: string[] = [];
      expect(await main(argv, { log: s => lines.push(s) })).toBe(2);
      expect(lines.join("\n")).toContain("continuity | autopilot | board | session-scan");
    }
  });
});

describe("respond dispatch", () => {
  it("prints nothing and exits 0 when the stop stands", async () => {
    // Injected stdin: empty hook input → respond lacks session_id → allow.
    // The contract under test: exit 0, completely silent stdout.
    const lines: string[] = [];
    const code = await main(["respond"], { log: s => lines.push(s), readStdin: async () => ({}) });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
  });
});

describe("notify dispatch", () => {
  // Hook targets are deliberately absent from help: they exist to be invoked by
  // settings.json, never typed.
  it("keeps the hook target out of help, drains stdin, stays silent, and exits zero", async () => {
    const help: string[] = [];
    await main(["help"], { log: line => help.push(line) });
    expect(help.join("\n")).not.toContain("gradient notify");

    vi.mocked(notify).mockClear();
    let drained = false;
    const logs: string[] = [];
    const code = await main(["notify"], {
      log: line => logs.push(line),
      readStdin: async () => {
        drained = true;
        return { ignored: "transcript text" };
      },
    });
    expect(code).toBe(0);
    expect(drained).toBe(true);
    expect(vi.mocked(notify)).toHaveBeenCalledOnce();
    expect(logs).toEqual([]);
  });
});

describe("retired recall dispatch", () => {
  it("does not advertise the removed feature in help", async () => {
    const lines: string[] = [];
    await main(["help"], { log: line => lines.push(line) });
    expect(lines.join("\n")).not.toContain("gradient recall");
  });

  // The leftover UserPromptSubmit hook must not fall through to the
  // unknown-command handler: its stdout is injected into the model's context,
  // so the usage text would be read as instructions on every prompt.
  it("stays silent and exits zero rather than printing usage", async () => {
    const lines: string[] = [];
    expect(await main(["recall"], { home: "/home", log: line => lines.push(line), readStdin: async () => ({}) })).toBe(0);
    expect(lines).toEqual([]);
  });

  it("stays silent for the old on/off/status arguments too", async () => {
    const lines: string[] = [];
    for (const action of ["on", "off", "status", "sideways"]) {
      expect(await main(["recall", action], { home: "/home", log: line => lines.push(line) })).toBe(0);
    }
    expect(lines).toEqual([]);
  });
});

describe("report rendering", () => {
  it("shows installed artifacts with uses, last use, and the removal nudge", async () => {
    const lines: string[] = [];
    expect(await main([], { home: "/home", log: line => lines.push(line) })).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("installed");
    expect(output).toContain("0 use(s) · last never");
    expect(output).toContain("gradient remove dead");
    expect(output).not.toContain("≈0m saved");
  });

  it("shows the realized-savings clause only for artifacts that were used", async () => {
    vi.mocked(buildReport).mockResolvedValueOnce({
      ...(await vi.mocked(buildReport).getMockImplementation()!("/repo", {})),
      adoption: [
        { name: "dead", type: "skill", createdAt: "2026-05-01", uses: 0, realizedMinutesSaved: 0, suggestRemoval: true },
        { name: "ship", type: "command", createdAt: "2026-06-01", uses: 4, lastUsed: "2026-07-10T00:00:00Z", realizedMinutesSaved: 6, suggestRemoval: false },
      ],
    });
    const lines: string[] = [];
    expect(await main([], { log: line => lines.push(line) })).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("0 use(s) · last never");
    expect(output).not.toContain("≈0m saved");
    expect(output).toContain("4 use(s) · ≈6m saved · last 2026-07-10");
  });

  it("reports which background features are on", async () => {
    const lines: string[] = [];
    await main([], { log: line => lines.push(line) });
    expect(lines.join("\n")).toContain("features:");
    expect(lines.join("\n")).toContain("continuity");
  });
});

// The compatibility promise is "no retired verb reads as a typo for one
// release", and the way to break it is to document a verb and forget to wire
// it — which is what happened to `explain` in 0.7.0. So this drives the
// exported list rather than repeating it: adding a name to RETIRED without
// handling it fails here instead of shipping `unknown command`.
describe("retired verbs never read as typos", () => {
  it("resolves every verb the surface still documents", async () => {
    // Verbs with behaviour of their own, plus the sentence-only ones. Both
    // kinds must exit 0; only the reason differs.
    const documented = [
      "insights", "stats", "mirror", "list", "board", "review",
      "continuity", "autopilot", ...RETIRED.keys(),
    ];
    for (const verb of documented) {
      const lines: string[] = [];
      const code = await main([verb], { home: "/home", log: line => lines.push(line) });
      expect(lines.join("\n"), `${verb} should not read as a typo`).not.toContain("unknown command");
      expect(code, `${verb} should exit 0`).toBe(0);
    }
  });

  it("still rejects a genuine typo, and a verb documented as deleted", async () => {
    for (const verb of ["stats-report", "migrate"]) {
      const lines: string[] = [];
      expect(await main([verb], { home: "/home", log: line => lines.push(line) })).toBe(2);
      expect(lines.join("\n")).toContain("unknown command");
    }
  });

  it("names the replacement for each sentence-only retirement", async () => {
    for (const [verb, replacement] of RETIRED) {
      const lines: string[] = [];
      expect(await main([verb], { home: "/home", log: line => lines.push(line) })).toBe(0);
      expect(lines.join("\n")).toContain(`gradient ${verb} is now ${replacement}`);
    }
  });
});

describe("retired report aliases", () => {
  it("prints the report and says so for each retired alias", async () => {
    for (const alias of ["stats", "mirror", "list"]) {
      vi.mocked(buildReport).mockClear();
      const lines: string[] = [];
      expect(await main([alias], { home: "/home", log: line => lines.push(line) })).toBe(0);
      expect(vi.mocked(buildReport)).toHaveBeenCalledOnce();
      expect(lines.join("\n")).toContain(`gradient ${alias} is now just gradient`);
      expect(lines.join("\n")).toContain("prompts");
    }
  });

  // --user is a scope, not a different report: installed artifacts and other
  // sessions in this repository are not the answer to a cross-project question.
  it("keeps the narrower cross-project view behind --user", async () => {
    vi.mocked(insights).mockClear();
    vi.mocked(buildReport).mockClear();
    const lines: string[] = [];
    expect(await main(["insights", "--user"], { home: "/home", log: line => lines.push(line) })).toBe(0);
    expect(vi.mocked(insights)).toHaveBeenCalledWith({ projectDir: expect.any(String), user: true, home: "/home" });
    expect(vi.mocked(buildReport)).not.toHaveBeenCalled();
    const output = lines.join("\n");
    expect(output).toContain("prompts");
    expect(output).toContain("gradient on autopilot");
    expect(output).toContain("in-session failure loops");
    expect(output).not.toContain("installed");
  });

  it("writes and reports the self-contained HTML view when requested", async () => {
    vi.mocked(writeInsightsHtml).mockClear();
    const lines: string[] = [];
    expect(await main(["insights", "--html"], { log: line => lines.push(line) })).toBe(0);
    expect(vi.mocked(writeInsightsHtml)).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
    expect(lines.join("\n")).toContain(".gradient/insights.html");
  });
});

describe("continuity alias", () => {
  it("routes the old grammar to the consent verb", async () => {
    vi.mocked(setFeature).mockClear();
    const lines: string[] = [];
    expect(await main(["continuity", "on"], { home: "/home", log: line => lines.push(line) })).toBe(0);
    expect(await main(["continuity", "off"], { home: "/home", log: line => lines.push(line) })).toBe(0);
    expect(vi.mocked(setFeature)).toHaveBeenNthCalledWith(1, "continuity", true, expect.any(String), { home: "/home" });
    expect(vi.mocked(setFeature)).toHaveBeenNthCalledWith(2, "continuity", false, expect.any(String), { home: "/home" });
  });

  it("answers the old status question with the report", async () => {
    vi.mocked(buildReport).mockClear();
    const lines: string[] = [];
    expect(await main(["continuity", "status"], { home: "/home", log: line => lines.push(line) })).toBe(0);
    expect(vi.mocked(buildReport)).toHaveBeenCalledOnce();
    expect(lines.join("\n")).toContain("features:");
  });

  it("rejects an unknown action", async () => {
    const lines: string[] = [];
    expect(await main(["continuity", "sideways"], { log: line => lines.push(line) })).toBe(2);
    expect(lines.join("\n")).toContain("unknown continuity action");
  });

  it("keeps the recap hook silent when no checkpoint exists", async () => {
    vi.mocked(recap).mockResolvedValueOnce(null);
    const lines: string[] = [];
    expect(await main(["recap"], { log: line => lines.push(line) })).toBe(0);
    expect(lines).toEqual([]);
  });
});

describe("bundle dispatch", () => {
  it("requires a name and stays out of help", async () => {
    const missing: string[] = [];
    expect(await main(["bundle"], { log: line => missing.push(line) })).toBe(2);
    expect(missing.join("\n")).toContain("bundle needs a name");

    const help: string[] = [];
    await main(["help"], { log: line => help.push(line) });
    expect(help.join("\n")).not.toContain("gradient bundle");
  });

  it("prints the bundle tree and a current-schema marketplace catalog", async () => {
    vi.mocked(bundleCommand).mockClear();
    const lines: string[] = [];
    expect(await main(["bundle", "Team Toolkit!"], { log: line => lines.push(line) })).toBe(0);
    expect(vi.mocked(bundleCommand)).toHaveBeenCalledWith(expect.any(String), "Team Toolkit!", { withHooks: false });
    const output = lines.join("\n");
    expect(output).toContain(".claude-plugin/plugin.json");
    expect(output).toContain("skipped a-loop");
    expect(output).toContain('"owner"');
    expect(output).toContain('"description": "Team workflows packaged by gradient"');
    expect(output).toContain('"name": "team-toolkit"');
    expect(output).toContain('"source": "./team-toolkit"');
    expect(output).toContain("Codex marketplace entry");
    expect(output).toContain('"path": "./plugins/team-toolkit"');
    expect(output).toContain('"installation": "AVAILABLE"');
  });

  it("rejects hook export before building anything", async () => {
    vi.mocked(bundleCommand).mockClear();
    const lines: string[] = [];
    expect(await main(["bundle", "kit", "--with-hooks"], { log: line => lines.push(line) })).toBe(2);
    expect(vi.mocked(bundleCommand)).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("recipient-side consent");
  });

  it("single-quotes shell metacharacters in the printed plugin command", async () => {
    const malicious = "/tmp/$(touch pwned)`touch also-pwned`'kit";
    vi.mocked(bundleCommand).mockResolvedValueOnce({ dir: malicious, files: [], skipped: [] });
    const lines: string[] = [];
    expect(await main(["bundle", "kit"], { log: line => lines.push(line) })).toBe(0);
    expect(lines.join("\n")).toContain(`claude --plugin-dir ${posixShellQuote(malicious)}`);
    expect(posixShellQuote("a'b")).toBe("'a'\\''b'");
  });

  it("omits an executable command for a control-character path", async () => {
    vi.mocked(bundleCommand).mockResolvedValueOnce({ dir: "/tmp/bad\npath", files: [], skipped: [] });
    const lines: string[] = [];
    expect(await main(["bundle", "kit"], { log: line => lines.push(line) })).toBe(0);
    expect(lines.join("\n")).toContain("executable command omitted");
    expect(lines.join("\n")).not.toContain("claude --plugin-dir");
  });
});

it("board: routes the old grammar, isolates state, and keeps empty hook output silent", async () => {
  const lines: string[] = [];
  const log = (s: string) => { lines.push(s); };
  const home = await mkdtemp(join(tmpdir(), "gradient-cli-home-"));

  expect(await main(["--help"], { log, home })).toBe(0);
  expect(lines.join("\n")).not.toContain("gradient board");

  expect(await main(["board", "bogus"], { log, home })).toBe(2);

  vi.mocked(setFeature).mockClear();
  expect(await main(["board", "on"], { log, home })).toBe(0);
  expect(vi.mocked(setFeature)).toHaveBeenCalledWith("board", true, expect.any(String), { home });

  // Hook target without consent: exit 0, no output — never breaks a session.
  lines.length = 0;
  vi.mocked(boardDigest).mockClear();
  const code = await main(["board", "digest"], {
    log, home, readStdin: async () => ({ session_id: "s1" }),
  });
  expect(code).toBe(0);
  expect(lines).toEqual([]);
  expect(vi.mocked(boardDigest)).toHaveBeenCalledWith(
    { session_id: "s1" }, expect.any(String), { home },
  );

  vi.mocked(boardRefresh).mockClear();
  expect(await main(["board", "refresh"], {
    log, home, readStdin: async () => ({ session_id: "s1" }),
  })).toBe(0);
  expect(vi.mocked(boardRefresh)).toHaveBeenCalledWith(
    { session_id: "s1" }, expect.any(String), { home },
  );

  // Bare `board` was the cross-session view; the report carries it now.
  vi.mocked(buildReport).mockClear();
  lines.length = 0;
  expect(await main(["board"], { log, home })).toBe(0);
  expect(vi.mocked(buildReport)).toHaveBeenCalledOnce();
  expect(lines.join("\n")).toContain("gradient board status is now part of gradient");

  // The namespaced form reaches the same hook targets.
  vi.mocked(boardDigest).mockClear();
  lines.length = 0;
  expect(await main(["hook", "board-digest"], {
    log, home, readStdin: async () => ({ session_id: "s2" }),
  })).toBe(0);
  expect(vi.mocked(boardDigest)).toHaveBeenCalledWith({ session_id: "s2" }, expect.any(String), { home });
  expect(lines).toEqual([]);
});

describe("hook namespace", () => {
  it("routes every hook target and stays silent on an unknown one", async () => {
    vi.mocked(notify).mockClear();
    const lines: string[] = [];
    expect(await main(["hook", "notify"], { log: s => lines.push(s), readStdin: async () => ({}) })).toBe(0);
    expect(vi.mocked(notify)).toHaveBeenCalledOnce();

    // An unknown target must not print usage: this output is read by the
    // session the hook fires in.
    expect(await main(["hook", "nonsense"], { log: s => lines.push(s) })).toBe(0);
    expect(await main(["hook"], { log: s => lines.push(s) })).toBe(0);
    expect(lines).toEqual([]);
  });
});
