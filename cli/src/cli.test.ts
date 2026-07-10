import { describe, it, expect, vi } from "vitest";
import { parseCliArgs, main, posixShellQuote } from "./cli.js";
import { spawnDetached } from "./core/spawn.js";
import { migrate } from "./commands/migrate.js";
import { recallHook, recallStatus, setRecall } from "./commands/recall.js";
import { stats } from "./commands/stats.js";
import { insights, writeInsightsHtml } from "./commands/insights.js";
import { continuityStatus, setContinuity } from "./commands/continuity.js";
import { recap } from "./commands/recap.js";
import { bundleCommand } from "./commands/bundle.js";

vi.mock("./core/spawn.js", () => ({ spawnDetached: vi.fn() }));
vi.mock("./commands/migrate.js", () => ({
  migrate: vi.fn(async () => ({ migrated: ["ship"], skipped: ["ghost"] })),
}));
vi.mock("./commands/recall.js", () => ({
  recallHook: vi.fn(async () => ({ context: "use the installed skill" })),
  recallStatus: vi.fn(async () => ({ installed: true, entries: 2, builtAt: "2026-07-09T00:00:00Z" })),
  setRecall: vi.fn(async (on: boolean) => ({ installed: on, settingsPath: "/repo/.claude/settings.local.json" })),
}));
vi.mock("./commands/stats.js", () => ({
  stats: vi.fn(async () => ({
    total: 0,
    covered: 0,
    coveragePct: 0,
    sessionScanEnabled: false,
    patterns: [],
    adoption: [{
      name: "dead",
      type: "skill",
      createdAt: "2026-05-01",
      uses: 0,
      lastUsed: undefined,
      retypesCaught: 0,
      suggestRemoval: true,
    }],
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
    recommendations: [{ metric: "nudges", line: "try: gradient autopilot nudge" }],
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

  it("parses the migrate --dry-run flag", () => {
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
  it("returns 0 and prints help for no command", async () => {
    const logs: string[] = [];
    const code = await main([], { log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("gradient");
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

  it("lists migrate in help and dispatches dry runs", async () => {
    const help: string[] = [];
    await main([], { log: message => help.push(message) });
    expect(help.join("\n")).toContain("gradient migrate [--dry-run]");

    vi.mocked(migrate).mockClear();
    const logs: string[] = [];
    const code = await main(["migrate", "--dry-run"], { log: message => logs.push(message) });
    expect(code).toBe(0);
    expect(vi.mocked(migrate)).toHaveBeenCalledWith(expect.any(String), { dryRun: true });
    expect(logs.join("\n")).toContain("would migrate");
    expect(logs.join("\n")).toContain("skipped ghost");
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
});

describe("autopilot dispatch", () => {
  it("help text lists autopilot", async () => {
    const lines: string[] = [];
    await main([], { log: s => lines.push(s) });
    expect(lines.join("\n")).toContain("gradient autopilot <off|nudge>");
  });

  it("rejects an unknown autopilot mode", async () => {
    const lines: string[] = [];
    const code = await main(["autopilot", "sideways"], { log: s => lines.push(s) });
    expect(code).toBe(2);
    expect(lines.join("\n")).toContain("unknown autopilot mode");
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

describe("recall dispatch", () => {
  it("lists the recall manager in help", async () => {
    const lines: string[] = [];
    await main([], { log: line => lines.push(line) });
    expect(lines.join("\n")).toContain("gradient recall <on|off|status>");
  });

  it("prints only structured UserPromptSubmit JSON when the hook hints", async () => {
    vi.mocked(recallHook).mockResolvedValueOnce({ context: "use the installed skill" });
    const lines: string[] = [];
    const input = { prompt: "prepare this pull request for shipping", cwd: "/repo" };
    const code = await main(["recall"], { log: line => lines.push(line), readStdin: async () => input });
    expect(code).toBe(0);
    expect(vi.mocked(recallHook)).toHaveBeenCalledWith(input);
    expect(lines).toEqual([
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "use the installed skill",
        },
      }),
    ]);
  });

  it("is silent and exits zero when the hook has no hint", async () => {
    vi.mocked(recallHook).mockResolvedValueOnce({});
    const lines: string[] = [];
    expect(await main(["recall"], { log: line => lines.push(line), readStdin: async () => ({}) })).toBe(0);
    expect(lines).toEqual([]);
  });

  it("manages on, off, and status explicitly", async () => {
    vi.mocked(setRecall).mockClear();
    expect(await main(["recall", "on"], { log: () => {} })).toBe(0);
    expect(await main(["recall", "off"], { log: () => {} })).toBe(0);
    expect(vi.mocked(setRecall)).toHaveBeenNthCalledWith(1, true, expect.any(String));
    expect(vi.mocked(setRecall)).toHaveBeenNthCalledWith(2, false, expect.any(String));

    const lines: string[] = [];
    expect(await main(["recall", "status"], { log: line => lines.push(line) })).toBe(0);
    expect(vi.mocked(recallStatus)).toHaveBeenCalled();
    expect(lines.join("\n")).toContain("2 artifacts");
  });

  it("rejects unknown manager actions", async () => {
    const lines: string[] = [];
    expect(await main(["recall", "sideways"], { log: line => lines.push(line) })).toBe(2);
    expect(lines.join("\n")).toContain("unknown recall action");
  });
});

describe("stats adoption rendering", () => {
  it("shows uses, last use, retypes caught, and the removal nudge", async () => {
    vi.mocked(stats).mockClear();
    const lines: string[] = [];
    expect(await main(["stats"], { log: line => lines.push(line) })).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("adoption:");
    expect(output).toContain("0 use(s) · last never · 0 retype(s) caught");
    expect(output).toContain("gradient remove dead");
  });
});

describe("insights dispatch", () => {
  it("lists and renders the local behavior report", async () => {
    const help: string[] = [];
    await main([], { log: line => help.push(line) });
    expect(help.join("\n")).toContain("gradient insights [--user] [--html]");

    vi.mocked(insights).mockClear();
    const lines: string[] = [];
    expect(await main(["insights", "--user"], { log: line => lines.push(line) })).toBe(0);
    expect(vi.mocked(insights)).toHaveBeenCalledWith({ projectDir: expect.any(String), user: true });
    expect(lines.join("\n")).toContain("prompts");
    expect(lines.join("\n")).toContain("gradient autopilot nudge");
  });

  it("writes and reports the self-contained HTML view when requested", async () => {
    vi.mocked(writeInsightsHtml).mockClear();
    const lines: string[] = [];
    expect(await main(["insights", "--html"], { log: line => lines.push(line) })).toBe(0);
    expect(vi.mocked(writeInsightsHtml)).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
    expect(lines.join("\n")).toContain(".gradient/insights.html");
  });
});

describe("continuity dispatch", () => {
  it("lists the manager and dispatches on, off, and status", async () => {
    const help: string[] = [];
    await main([], { log: line => help.push(line) });
    expect(help.join("\n")).toContain("gradient continuity <on|off|status>");

    vi.mocked(setContinuity).mockClear();
    expect(await main(["continuity", "on"], { log: () => {} })).toBe(0);
    expect(await main(["continuity", "off"], { log: () => {} })).toBe(0);
    expect(vi.mocked(setContinuity)).toHaveBeenNthCalledWith(1, true, expect.any(String));
    expect(vi.mocked(setContinuity)).toHaveBeenNthCalledWith(2, false, expect.any(String));

    const lines: string[] = [];
    expect(await main(["continuity", "status"], { log: line => lines.push(line) })).toBe(0);
    expect(vi.mocked(continuityStatus)).toHaveBeenCalled();
    expect(lines.join("\n")).toContain("checkpoint (PreCompact):");
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
  it("requires a name and lists the command in help", async () => {
    const missing: string[] = [];
    expect(await main(["bundle"], { log: line => missing.push(line) })).toBe(2);
    expect(missing.join("\n")).toContain("bundle needs a name");

    const help: string[] = [];
    await main([], { log: line => help.push(line) });
    expect(help.join("\n")).toContain("gradient bundle <name>");
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
