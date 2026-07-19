import { describe, expect, it } from "vitest";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { boardStateDir, locateRepo, resolveBoardRoot } from "./board.js";
import { projectCacheDir } from "../config.js";

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
