import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  boardDigest,
  boardRefresh,
  boardShow,
  DIGEST_COMMAND,
  DIGEST_SUB,
  REFRESH_COMMAND,
  REFRESH_SUB,
  setBoard,
} from "./board.js";
import { hookInstalled, installHook } from "../core/settings.js";
import { loadConfig } from "../config.js";
import { boardStateDir } from "../core/board.js";
import { isGradientHookFor } from "../core/hookBinary.js";

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

describe("setBoard", () => {
  it("installs both hooks and records consent keyed by the board root", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    await initRepo(repo);

    const result = await setBoard(true, repo, { home });
    expect(result.on).toBe(true);
    expect(await hookInstalled(repo, "SessionStart", cmd => isGradientHookFor(cmd, DIGEST_SUB))).toBe(true);
    expect(await hookInstalled(repo, "UserPromptSubmit", cmd => isGradientHookFor(cmd, REFRESH_SUB))).toBe(true);
    expect((await loadConfig(home)).boardProjects).toEqual([repo]);

    const off = await setBoard(false, repo, { home });
    expect(off.on).toBe(false);
    expect(await hookInstalled(repo, "SessionStart", cmd => isGradientHookFor(cmd, DIGEST_SUB))).toBe(false);
    expect((await loadConfig(home)).boardProjects).toEqual([]);
    expect(existsSync(boardStateDir(repo, home))).toBe(false);
  });

  /**
   * 0.6.0 through 0.8.3 wrote `board digest` and `board refresh`, which nothing
   * dispatched. Those hooks are still in the settings files of everyone who
   * turned the board on, and `off` is the only way out of them, so removal has
   * to recognise the form gradient no longer writes.
   */
  it("removes the hooks an older gradient wrote, not only its own", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    await initRepo(repo);
    await installHook(repo, "SessionStart", "/usr/bin/node /old/gradient/bin/gradient.mjs board digest");
    await installHook(repo, "UserPromptSubmit", "/usr/bin/node /old/gradient/bin/gradient.mjs board refresh");

    await setBoard(false, repo, { home });
    const anyLeft = async (event: string) =>
      await hookInstalled(repo, event, cmd => /gradient/i.test(cmd));
    expect(await anyLeft("SessionStart")).toBe(false);
    expect(await anyLeft("UserPromptSubmit")).toBe(false);
  });

  // Turning it on again must not leave the stale pair beside the working one.
  it("replaces an older gradient's hook instead of installing a second", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    await initRepo(repo);
    await installHook(repo, "SessionStart", "/usr/bin/node /old/gradient/bin/gradient.mjs board digest");

    await setBoard(true, repo, { home });
    expect(await hookInstalled(repo, "SessionStart", cmd => isGradientHookFor(cmd, "board digest"))).toBe(false);
    expect(await hookInstalled(repo, "SessionStart", cmd => isGradientHookFor(cmd, DIGEST_SUB))).toBe(true);
  });

  it("refuses outside a git repository", async () => {
    const home = await mkdtemp(join(tmpdir(), "gradient-board-home-"));
    const dir = await mkdtemp(join(tmpdir(), "gradient-board-plain-"));
    await expect(setBoard(true, dir, { home })).rejects.toThrow(/git repository/);
  });

  it("a failed hook install rolls back and leaves no consent behind", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    await initRepo(repo);
    // .claude as a file makes settings.json unwritable, so installHook throws.
    await writeFile(join(repo, ".claude"), "not a directory\n");
    await expect(setBoard(true, repo, { home })).rejects.toThrow();
    expect((await loadConfig(home)).boardProjects ?? []).toEqual([]);
  });
});

describe("hook entry points", () => {
  it("no-op without consent, produce a wrapped digest with consent, and never throw", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    await initRepo(repo);
    const gh = async () => "[]";

    expect(await boardDigest({ session_id: "me" }, repo, { home, gh })).toBeNull();

    await setBoard(true, repo, { home });
    const digest = await boardDigest({ session_id: "me" }, repo, { home, gh });
    expect(digest).toContain("<gradient-board>");
    expect(digest).toContain("untrusted data");
    expect(digest).toContain("gradient board — 0 other sessions in this repo");
    expect(await boardRefresh({ session_id: "me" }, repo, { home, gh })).toBeNull();

    // Consent revoked → both entry points go inert (stale-hook safety).
    await setBoard(false, repo, { home });
    expect(await boardDigest({ session_id: "me" }, repo, { home, gh })).toBeNull();
    expect(await boardRefresh({ session_id: "me" }, repo, { home, gh })).toBeNull();

    // Entry points swallow even a non-repo failure.
    const plain = await mkdtemp(join(tmpdir(), "gradient-board-plain-"));
    expect(await boardDigest({}, plain, { home, gh })).toBeNull();
  });

  it("boardShow is loud outside a repo and needs no consent inside one", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-home-")));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "gradient-board-repo-")));
    await initRepo(repo);
    const gh = async () => { throw new Error("no gh"); };
    const digest = await boardShow(repo, { home, gh });
    expect(digest).toContain("(PR info unavailable)");
    const plain = await mkdtemp(join(tmpdir(), "gradient-board-plain-"));
    await expect(boardShow(plain, { home })).rejects.toThrow(/git repository/);
  });
});
