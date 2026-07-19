import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  boardStateDir,
  collectRepoState,
  discoverClaudeSessions,
  discoverCodexSessions,
  extractEditedFiles,
  landedLine,
  locateRepo,
  openPrs,
  renderDigest,
  resolveBoardRoot,
  type BoardState,
} from "./board.js";
import { projectCacheDir } from "../config.js";
import { encodeProjectDir } from "./collect.js";

const execFileP = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  const run = (args: string[]) => execFileP("git", args, { cwd: dir });
  await run(["init", "-q", "-b", "main"]);
  await run(["config", "user.email", "t@test"]);
  await run(["config", "user.name", "t"]);
  await run(["config", "commit.gpgsign", "false"]);
  await writeFile(join(dir, "README.md"), "x\n");
  await run(["add", "."]);
  await run(["commit", "-q", "-m", "init"]);
}

describe("resolveBoardRoot", () => {
  it("resolves the main checkout from itself, a subdirectory, and a worktree", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    await initRepo(repo);
    const worktree = join(repo, ".worktrees", "feature");
    await execFileP("git", ["worktree", "add", "-q", worktree, "-b", "feature"], { cwd: repo });

    expect(await resolveBoardRoot(repo)).toBe(repo);
    expect(await resolveBoardRoot(worktree)).toBe(repo);
    const inWorktree = await locateRepo(worktree);
    expect(inWorktree?.root).toBe(repo);
    expect(await realpath(inWorktree!.toplevel)).toBe(await realpath(worktree));
  });

  it("returns null outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gradient-board-plain-"));
    expect(await resolveBoardRoot(dir)).toBeNull();
  });
});

describe("boardStateDir", () => {
  it("nests under the board root's project cache dir", () => {
    expect(boardStateDir("/repo/a", "/home/u"))
      .toBe(join(projectCacheDir("/repo/a", "/home/u"), "board"));
  });
});

function toolLine(name: string, file_path: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name, input: { file_path } }] },
  });
}

describe("extractEditedFiles", () => {
  it("collects Edit/Write paths, dedupes, caps at 5, and relativizes to the board root", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      toolLine("Read", "/repo/ignored.ts"),
      toolLine("Edit", "/repo/a.ts"),
      toolLine("Edit", "/repo/a.ts"),
      ...["b", "c", "d", "e", "f"].map(n => toolLine("Write", `/repo/${n}.ts`)),
      "not json",
    ];
    expect(extractEditedFiles(lines, "/repo"))
      .toEqual(["b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]);
  });

  it("keeps paths outside the board root absolute and redacts secrets", () => {
    const lines = [toolLine("Edit", "/elsewhere/x.ts")];
    expect(extractEditedFiles(lines, "/repo")).toEqual(["/elsewhere/x.ts"]);
  });
});

async function claudeTranscript(
  home: string,
  cwd: string,
  sessionId: string,
  opts: { branch?: string; sidechain?: boolean; ageMs?: number; extraLines?: string[] } = {},
): Promise<string> {
  const dir = join(home, ".claude", "projects", encodeProjectDir(cwd));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const record = JSON.stringify({
    type: "user",
    cwd,
    sessionId,
    gitBranch: opts.branch ?? "main",
    isSidechain: opts.sidechain ?? false,
    message: { role: "user", content: "hello" },
  });
  await writeFile(path, [...(opts.extraLines ?? []), record].join("\n") + "\n");
  if (opts.ageMs) {
    const then = new Date(Date.now() - opts.ageMs);
    await utimes(path, then, then);
  }
  return path;
}

describe("discoverClaudeSessions", () => {
  it("finds live and idle sessions across worktrees, excluding other repos and sidechains", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    const other = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-other-")));
    await initRepo(repo);
    await initRepo(other);
    const worktree = join(repo, ".worktrees", "feature");
    await execFileP("git", ["worktree", "add", "-q", worktree, "-b", "feature"], { cwd: repo });

    await claudeTranscript(home, repo, "s-main", {
      extraLines: [toolLine("Edit", join(repo, "cli/src/a.ts"))],
    });
    await claudeTranscript(home, worktree, "s-wt", { branch: "feature", ageMs: 20 * 60_000 });
    await claudeTranscript(home, other, "s-other");
    await claudeTranscript(home, repo, "s-side", { sidechain: true });
    await claudeTranscript(home, repo, "s-old", { ageMs: 2 * 3_600_000 });

    const sessions = await discoverClaudeSessions(repo, { home });
    const byId = Object.fromEntries(sessions.map(s => [s.sessionId, s]));
    expect(Object.keys(byId).sort()).toEqual(["s-main", "s-wt"]);
    expect(byId["s-main"]).toMatchObject({
      agent: "claude", branch: "main", worktree: "", liveness: "live",
      editing: ["cli/src/a.ts"],
    });
    expect(byId["s-wt"]).toMatchObject({
      branch: "feature", worktree: join(".worktrees", "feature"), liveness: "idle", editing: [],
    });
  });

  it("reports unreadable transcripts via onWarn instead of failing silently", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    await initRepo(repo);
    const path = await claudeTranscript(home, repo, "s-locked");
    await chmod(path, 0o000);
    const warnings: string[] = [];
    const sessions = await discoverClaudeSessions(repo, { home, onWarn: m => warnings.push(m) });
    await chmod(path, 0o600);
    expect(sessions).toEqual([]);
    expect(warnings.some(w => w.includes("skipped unreadable transcript"))).toBe(true);
  });
});

async function codexRollout(
  home: string,
  name: string,
  cwd: string,
  opts: { branch?: string; ageMs?: number } = {},
): Promise<string> {
  const dir = join(home, ".codex", "sessions", "2026", "07", "18");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  await writeFile(path, JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-18T00:00:00Z",
    payload: { id: name, cwd, source: "cli", git: { branch: opts.branch ?? "main" } },
  }) + "\n");
  if (opts.ageMs) {
    const then = new Date(Date.now() - opts.ageMs);
    await utimes(path, then, then);
  }
  return path;
}

describe("discoverCodexSessions", () => {
  it("finds live codex sessions in this repo's worktrees and skips other repos and stale files", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    const other = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-other-")));
    await initRepo(repo);
    await initRepo(other);
    const worktree = join(repo, ".worktrees", "cx");
    await execFileP("git", ["worktree", "add", "-q", worktree, "-b", "cx"], { cwd: repo });

    await codexRollout(home, "cx-live", worktree, { branch: "cx" });
    await codexRollout(home, "cx-other", other);
    await codexRollout(home, "cx-stale", repo, { ageMs: 2 * 3_600_000 });

    const sessions = await discoverCodexSessions(repo, { home });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent: "codex", sessionId: "cx-live", branch: "cx",
      worktree: join(".worktrees", "cx"), liveness: "live", editing: [],
    });
  });
});

describe("landedLine", () => {
  it("condenses GitHub merge subjects, keeping multi-segment branch names", () => {
    expect(landedLine("Merge pull request #16 from elliot-ylambda/spec/plugin"))
      .toBe("PR #16 spec/plugin");
    expect(landedLine("fix: a plain commit")).toBe("fix: a plain commit");
  });
});

describe("collectRepoState", () => {
  it("reports landed subjects and behind counts from a worktree", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    await initRepo(repo);
    const worktree = join(repo, ".worktrees", "feature");
    await execFileP("git", ["worktree", "add", "-q", worktree, "-b", "feature"], { cwd: repo });
    await writeFile(join(repo, "new.txt"), "y\n");
    await execFileP("git", ["add", "."], { cwd: repo });
    await execFileP("git", ["commit", "-q", "-m", "feat: land something"], { cwd: repo });

    const state = await collectRepoState(repo, worktree);
    expect(state).toMatchObject({ defaultBranch: "main", ahead: 0, behind: 1 });
    expect(state?.landed).toContain("feat: land something");
    expect(state?.mainTip).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gradient-board-plain-"));
    expect(await collectRepoState(dir, dir)).toBeNull();
  });
});

describe("openPrs", () => {
  const payload = JSON.stringify([
    { number: 18, headRefName: "codex/release-cleanup", baseRefName: "main" },
  ]);

  it("fetches, caches, then serves the fresh cache without re-running gh", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    let calls = 0;
    const gh = async () => { calls++; return payload; };
    const now = 1_000_000_000_000;
    expect(await openPrs("/repo/a", { home, now, gh }))
      .toEqual({ lines: ["#18 codex/release-cleanup → main"] });
    expect(await openPrs("/repo/a", { home, now: now + 60_000, gh }))
      .toEqual({ lines: ["#18 codex/release-cleanup → main"] });
    expect(calls).toBe(1);
  });

  it("labels a stale cache when gh fails, and reports unavailable with no cache", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    const now = 1_000_000_000_000;
    const failing = async () => { throw new Error("gh missing"); };
    expect(await openPrs("/repo/a", { home, now, gh: failing })).toBe("unavailable");
    await openPrs("/repo/a", { home, now, gh: async () => payload });
    const later = await openPrs("/repo/a", { home, now: now + 12 * 60_000, gh: failing });
    expect(later).toEqual({ lines: ["#18 codex/release-cleanup → main"], staleMs: 12 * 60_000 });
  });
});

function stateFixture(overrides: Partial<BoardState> = {}): BoardState {
  return {
    root: "/repo",
    defaultBranch: "main",
    mainTip: "a".repeat(40),
    sessions: [{
      agent: "codex", sessionId: "cx", branch: "codex/release-cleanup",
      worktree: ".worktrees/release-cleanup", liveness: "live", ageMs: 3 * 60_000,
      editing: ["cli/package.json", "Makefile"],
    }, {
      agent: "claude", sessionId: "cl", branch: "spec/plugin",
      worktree: "", liveness: "idle", ageMs: 41 * 60_000, editing: [],
    }],
    landed: ["PR #16 spec/plugin"],
    ahead: 0,
    behind: 2,
    prs: { lines: ["#18 codex/release-cleanup → main"] },
    ...overrides,
  };
}

describe("renderDigest", () => {
  it("renders the spec's digest shape", () => {
    expect(renderDigest(stateFixture())).toBe([
      "gradient board — 2 other sessions in this repo",
      "• codex · codex/release-cleanup · .worktrees/release-cleanup · live (3m)",
      "  editing: cli/package.json, Makefile",
      "• claude · spec/plugin · main checkout · idle (41m)",
      "landed on main (24h): PR #16 spec/plugin",
      "open PRs: #18 codex/release-cleanup → main",
      "heads-up: your branch is 2 commits behind main",
    ].join("\n"));
  });

  it("marks the caller's own session with (you)", () => {
    const withSelf = stateFixture({
      self: {
        agent: "claude", sessionId: "me", branch: "spec/gradient-board",
        worktree: "", liveness: "live", ageMs: 0, editing: [],
      },
    });
    expect(renderDigest(withSelf)).toContain("(you) claude · spec/gradient-board · main checkout");
  });

  it("states PR unavailability and stale-cache age instead of omitting", () => {
    expect(renderDigest(stateFixture({ prs: "unavailable", behind: 0 })))
      .toContain("open PRs: (PR info unavailable)");
    expect(renderDigest(stateFixture({ prs: { lines: ["#18 x → main"], staleMs: 12 * 60_000 } })))
      .toContain("open PRs (12m ago): #18 x → main");
  });

  it("caps output at 25 lines", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      agent: "claude" as const, sessionId: `s${i}`, branch: `b${i}`,
      worktree: "", liveness: "live" as const, ageMs: 60_000, editing: [],
    }));
    expect(renderDigest(stateFixture({ sessions: many })).split("\n").length).toBe(25);
  });
});
