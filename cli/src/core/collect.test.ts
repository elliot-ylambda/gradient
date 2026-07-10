import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir, matchesSince, collect } from "./collect.js";

describe("collect helpers", () => {
  it("encodes a cwd to a projects dir name", () => {
    expect(encodeProjectDir("/Users/x/projects/y")).toBe("-Users-x-projects-y");
    expect(encodeProjectDir("C:\\Users\\x\\project")).toBe("C--Users-x-project");
  });
  it("matchesSince keeps recent files and drops old ones", () => {
    const now = 1_000_000_000_000;
    const day = 86_400_000;
    expect(matchesSince(now - 2 * day, 7, now)).toBe(true);
    expect(matchesSince(now - 10 * day, 7, now)).toBe(false);
    expect(matchesSince(now - 999 * day, undefined, now)).toBe(true); // no filter
  });
});

describe("collect", () => {
  it("project scope sweeps the project's claude-worktrees sibling dirs", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const root = join(home, ".claude", "projects");
    const enc = encodeProjectDir("/p/x");
    await mkdir(join(root, enc), { recursive: true });
    await mkdir(join(root, `${enc}--claude-worktrees-feat`), { recursive: true });
    await mkdir(join(root, `${enc}-other`), { recursive: true }); // different project sharing the prefix
    await writeFile(join(root, enc, "a.jsonl"), "{}");
    await writeFile(join(root, `${enc}--claude-worktrees-feat`, "wt.jsonl"), "{}");
    await writeFile(join(root, `${enc}-other`, "n.jsonl"), "{}");
    const files = await collect({ scope: "project", projectPath: "/p/x", home });
    expect(files.map(f => f.split("/").pop()).sort()).toEqual(["a.jsonl", "wt.jsonl"]);
  });

  it("finds project jsonl files and skips subagents", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const proj = join(home, ".claude", "projects", encodeProjectDir("/p/x"));
    await mkdir(join(proj, "subagents"), { recursive: true });
    await writeFile(join(proj, "a.jsonl"), "{}");
    await writeFile(join(proj, "subagents", "b.jsonl"), "{}");
    const files = await collect({ scope: "project", projectPath: "/p/x", home });
    expect(files.length).toBe(1);
    expect(files[0].endsWith("a.jsonl")).toBe(true);
  });

  it("does not follow a symlinked transcript root outside the user home", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const outside = await mkdtemp(join(tmpdir(), "grad-transcript-victim-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(outside, "stolen.jsonl"), '{"type":"user"}');
    await symlink(outside, join(home, ".claude", "projects"));
    expect(await collect({ scope: "all", home })).toEqual([]);
  });
});
