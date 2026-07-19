import { describe, expect, it } from "vitest";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { boardStateDir, extractEditedFiles, locateRepo, resolveBoardRoot } from "./board.js";
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
