import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayCommand } from "./core/hookBinary.js";
import { parseCliArgs, main, renderFindings } from "./cli.js";
import { recap } from "./commands/recap.js";
import { notify } from "./commands/notify.js";
import { optimize, undo } from "./commands/optimize.js";
import { sessionStart } from "./commands/sessionStart.js";
import { boardDigest, boardRefresh } from "./commands/board.js";
import { FEATURES, setFeature } from "./commands/features.js";
import type { Finding } from "./core/findings.js";

const FINDING: Finding = {
  id: "abc123",
  family: "drift",
  severity: "high",
  title: "AGENTS.md is not reaching Claude Code",
  detail: "Import it from CLAUDE.md.",
  evidence: "AGENTS.md exists; CLAUDE.md does not import it",
  targets: ["claude-code", "codex"],
  deterministic: true,
  commandBearing: false,
  changes: [{ op: "prepend-import", path: "/repo/CLAUDE.md", assistant: "claude-code", after: "@AGENTS.md" }],
};

vi.mock("./commands/optimize.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./commands/optimize.js")>()),
  optimize: vi.fn(async () => ({
    targets: ["claude-code"], findings: [FINDING], applied: [], skipped: [], installedSkill: [],
    features: [
      { name: "continuity", on: true, purpose: "checkpoint before compaction, recap on resume" },
      { name: "board", on: false, purpose: "cross-session digest on start and on prompt" },
    ],
  })),
  undo: vi.fn(async () => ({ restored: ["/repo/CLAUDE.md"], conflicted: [] })),
}));
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
    adoption: [],
    pending: [],
    features: [{ name: "continuity", on: true }],
    board: null,
  })),
}));
vi.mock("./commands/features.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./commands/features.js")>()),
  setFeature: vi.fn(async (name: string, on: boolean) => ({
    on, settingsPath: "/repo/.claude/settings.local.json", detail: on ? `${name} detail` : undefined,
  })),
}));
vi.mock("./commands/recap.js", () => ({ recap: vi.fn(async () => null) }));
vi.mock("./commands/notify.js", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("./commands/board.js", () => ({
  boardDigest: vi.fn(async () => null),
  boardRefresh: vi.fn(async () => null),
  setBoard: vi.fn(async (on: boolean) => ({ on, settingsPath: "/repo/.claude/settings.local.json" })),
}));
vi.mock("./commands/remove.js", () => ({ remove: vi.fn(async () => true) }));
vi.mock("./commands/respond.js", () => ({ respond: vi.fn(async () => ({ decision: "approve" })) }));
vi.mock("./commands/checkpoint.js", () => ({ checkpoint: vi.fn(async () => {}) }));

describe("parseCliArgs", () => {
  it("splits the command from its flags", () => {
    const parsed = parseCliArgs(["optimize", "--target", "both", "--auto"]);
    expect(parsed.command).toBe("optimize");
    expect(parsed.flags.target).toBe("both");
    expect(parsed.flags.auto).toBe(true);
  });

  it("accepts repeated and comma-joined id flags alike", async () => {
    expect(parseCliArgs(["optimize", "--apply", "a", "--apply", "b"]).flags.apply).toEqual(["a", "b"]);
    expect(parseCliArgs(["optimize", "--apply", "a,b"]).flags.apply).toEqual(["a,b"]);

    const calls: string[][] = [];
    vi.mocked(optimize).mockClear();
    await main(["optimize", "--apply", "a,b", "--apply", "c"], { log: () => {} });
    calls.push(vi.mocked(optimize).mock.calls[0][1]!.apply!);
    expect(calls[0]).toEqual(["a", "b", "c"]);
  });

  it("keeps positionals for the verbs that take a name", () => {
    expect(parseCliArgs(["remove", "ship-it"]).positionals).toEqual(["ship-it"]);
  });
});

describe("unknown input", () => {
  it("exits 2 on an unknown command and shows the four verbs", async () => {
    const lines: string[] = [];
    expect(await main(["frobnicate"], { log: line => lines.push(line) })).toBe(2);
    const out = lines.join("\n");
    expect(out).toContain("unknown command: frobnicate");
    expect(out).toContain("gradient optimize");
  });

  it("exits 2 on an unknown option rather than crashing", async () => {
    const lines: string[] = [];
    expect(await main(["optimize", "--nope"], { log: line => lines.push(line) })).toBe(2);
    expect(lines.join("\n")).toContain("--nope");
  });

  // Every verb this release removed. A data-driven list is the point: the
  // previous alias test enumerated names by hand and so could not catch the one
  // the implementation forgot, which is exactly how `explain` shipped broken.
  const DELETED = [
    "scan", "review", "apply", "init", "explain", "migrate", "bundle",
    "insights", "stats", "mirror", "list", "continuity", "autopilot", "board", "recall",
  ];
  it.each(DELETED)("treats the removed verb %s as unknown", async verb => {
    const lines: string[] = [];
    // `recall` keeps a silent fast path in bin.ts, never in the CLI switch.
    expect(await main([verb], { log: line => lines.push(line) })).toBe(2);
    expect(lines.join("\n")).toContain("unknown command");
  });
});

describe("--version / --help", () => {
  it("prints a bare version and exits 0", async () => {
    const lines: string[] = [];
    expect(await main(["--version"], { log: line => lines.push(line) })).toBe(0);
    expect(lines[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints help for every spelling", async () => {
    for (const argv of [["--help"], ["-h"], ["help"]]) {
      const lines: string[] = [];
      expect(await main(argv, { log: line => lines.push(line) })).toBe(0);
      const out = lines.join("\n");
      expect(out).toContain("gradient optimize");
      expect(out).toContain("gradient remove");
      expect(out).toContain("gradient on|off");
    }
  });

  it("documents no verb it does not have", async () => {
    const lines: string[] = [];
    await main(["help"], { log: line => lines.push(line) });
    const out = lines.join("\n");
    for (const gone of ["gradient scan", "gradient review", "gradient init", "gradient bundle"]) {
      expect(out).not.toContain(gone);
    }
  });
});

describe("optimize dispatch", () => {
  it("renders findings grouped with an apply line", async () => {
    const lines: string[] = [];
    expect(await main(["optimize"], { log: line => lines.push(line) })).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("drift");
    expect(out).toContain("AGENTS.md is not reaching Claude Code");
    expect(out).toContain(`${displayCommand()} optimize --apply abc123`);
  });

  it("says so plainly when there is nothing to change", async () => {
    vi.mocked(optimize).mockResolvedValueOnce({
      targets: ["claude-code"], findings: [], applied: [], skipped: [], installedSkill: [],
    });
    const lines: string[] = [];
    await main(["optimize"], { log: line => lines.push(line) });
    expect(lines.join("\n")).toContain("nothing to change");
  });

  it("emits JSON with no banner so an agent can parse stdout", async () => {
    const lines: string[] = [];
    expect(await main(["optimize", "--json"], { log: line => lines.push(line) })).toBe(0);
    const parsed = JSON.parse(lines.join("\n"));
    expect(parsed.findings[0].id).toBe("abc123");
    expect(parsed.findings[0].autoEligible).toBe(true);
  });

  it("passes the target flag through", async () => {
    vi.mocked(optimize).mockClear();
    await main(["optimize", "--target", "both"], { log: () => {} });
    expect(vi.mocked(optimize).mock.calls[0][1]).toMatchObject({ target: "both" });
  });

  it("reports what a run restored, and what it refused to touch", async () => {
    vi.mocked(undo).mockResolvedValueOnce({
      restored: ["/repo/CLAUDE.md"], conflicted: ["/repo/AGENTS.md"],
    });
    const lines: string[] = [];
    expect(await main(["optimize", "--undo", "20260813-000000-abcdef"], { log: line => lines.push(line) })).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("restored");
    expect(out).toContain("changed since the run, left alone");
  });

  it("names the run to undo after a write", async () => {
    vi.mocked(optimize).mockResolvedValueOnce({
      targets: ["claude-code"], findings: [], runId: "20260813-221000-abc123",
      applied: [{ id: "abc123", title: "bridged AGENTS.md", paths: ["/repo/CLAUDE.md"] }],
      skipped: [], installedSkill: [],
    });
    const lines: string[] = [];
    await main(["optimize", "--apply", "abc123"], { log: line => lines.push(line) });
    expect(lines.join("\n")).toContain("--undo 20260813-221000-abc123");
  });
});

describe("on|off dispatch", () => {
  it("turns a feature on and names the settings file", async () => {
    const lines: string[] = [];
    expect(await main(["on", "continuity"], { log: line => lines.push(line) })).toBe(0);
    expect(vi.mocked(setFeature)).toHaveBeenCalledWith("continuity", true, expect.any(String), expect.any(Object));
    expect(lines.join("\n")).toContain("settings.local.json");
  });

  it("rejects an unknown feature with the list of real ones", async () => {
    const lines: string[] = [];
    expect(await main(["on", "telepathy"], { log: line => lines.push(line) })).toBe(2);
    expect(lines.join("\n")).toContain("unknown feature: telepathy");
  });

  it("needs a feature name", async () => {
    expect(await main(["off"], { log: () => {} })).toBe(2);
  });
});

describe("report rendering", () => {
  it("prints the bare report", async () => {
    const lines: string[] = [];
    expect(await main([], { log: line => lines.push(line) })).toBe(0);
    expect(lines.join("\n")).toContain("prompts");
  });
});

describe("hook targets", () => {
  it("routes the namespaced form to the board hooks", async () => {
    vi.mocked(boardDigest).mockClear();
    expect(await main(["hook", "board-digest"], { log: () => {}, readStdin: async () => ({}) })).toBe(0);
    expect(vi.mocked(boardDigest)).toHaveBeenCalled();

    vi.mocked(boardRefresh).mockClear();
    await main(["hook", "board-refresh"], { log: () => {}, readStdin: async () => ({}) });
    expect(vi.mocked(boardRefresh)).toHaveBeenCalled();
  });

  it("stays silent on an unknown hook target rather than printing usage into a session", async () => {
    const lines: string[] = [];
    expect(await main(["hook", "nonsense"], { log: line => lines.push(line) })).toBe(0);
    expect(lines).toEqual([]);
  });

  it("routes a bare hook subcommand for settings written before the namespace", async () => {
    vi.mocked(sessionStart).mockClear();
    expect(await main(["session-start"], { log: () => {} })).toBe(0);
    expect(vi.mocked(sessionStart)).toHaveBeenCalled();

    vi.mocked(notify).mockClear();
    expect(await main(["notify"], { log: () => {}, readStdin: async () => ({}) })).toBe(0);
    expect(vi.mocked(notify)).toHaveBeenCalled();

    vi.mocked(recap).mockClear();
    expect(await main(["recap"], { log: () => {} })).toBe(0);
    expect(vi.mocked(recap)).toHaveBeenCalled();
  });

  it("keeps stdout empty when a hook target throws", async () => {
    vi.mocked(boardDigest).mockRejectedValueOnce(new Error("boom"));
    const lines: string[] = [];
    expect(await main(["hook", "board-digest"], { log: line => lines.push(line), readStdin: async () => ({}) })).toBe(0);
    expect(lines).toEqual([]);
  });
});

describe("the apply line", () => {
  const finding = (id: string, changes: Finding["changes"]): Finding => ({
    id,
    family: "skill-health",
    severity: "medium",
    title: `finding ${id}`,
    detail: "",
    evidence: "",
    targets: ["claude-code"],
    deterministic: true,
    commandBearing: false,
    changes,
  });
  const change = [{ op: "delete-file" as const, path: "/tmp/x", assistant: "claude-code" as const }];

  /**
   * `findings.slice(0, 3)` took the first three regardless of whether they
   * applied to anything. Report-only findings carry `changes: []` by design,
   * so gradient printed a headline command in which every id was a no-op —
   * the user copies the line gradient wrote and gets three skips.
   */
  it("names only ids that apply to something", () => {
    const lines: string[] = [];
    renderFindings(
      [finding("aaa", []), finding("bbb", change), finding("ccc", [])],
      line => lines.push(line),
    );
    const apply = lines.find(line => line.includes("--apply"))!;
    expect(apply).toContain("bbb");
    expect(apply).not.toContain("aaa");
    expect(apply).not.toContain("ccc");
  });

  it("offers no command at all when nothing can be applied", () => {
    const lines: string[] = [];
    renderFindings([finding("aaa", []), finding("bbb", [])], line => lines.push(line));
    const all = lines.join("\n");
    expect(all).not.toContain("--apply");
    expect(all).toContain("nothing here applies automatically");
    // The report is still useful, so the json hand-off must survive.
    expect(all).toContain("optimize --json");
  });
});

describe("the features block in optimize", () => {
  /**
   * `optimize` proposes file changes and said nothing about the four switches
   * that change how the assistant behaves — those lived only in `gradient`,
   * a different command. The person acting on findings is the person deciding
   * what to automate.
   */
  it("names each feature, and sells only the ones that are off", async () => {
    const home = await mkdtemp(join(tmpdir(), "gradient-feat-"));
    const lines: string[] = [];
    await main(["optimize", "--target", "both"], { log: l => lines.push(l), home });
    const out = lines.join("\n");
    expect(out).toContain("continuity");
    expect(out).toContain("board");
    // An `off` row with no purpose is a switch nobody can evaluate...
    expect(out).toContain("cross-session digest on start and on prompt");
    // ...and an `on` row is already doing its job, so it needs no pitch.
    expect(out).not.toContain("checkpoint before compaction, recap on resume");
    expect(out).toContain("on <feature>");
  });
});
