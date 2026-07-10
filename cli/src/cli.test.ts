import { describe, it, expect, vi } from "vitest";
import { parseCliArgs, main } from "./cli.js";
import { spawnDetached } from "./core/spawn.js";
import { migrate } from "./commands/migrate.js";
import { recallHook, recallStatus, setRecall } from "./commands/recall.js";
import { stats } from "./commands/stats.js";

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
