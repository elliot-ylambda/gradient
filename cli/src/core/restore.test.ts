import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changesSince, createRestorePoint, openRestorePoint, restoreTo } from "./restore.js";
import { loadResult, pruneRuns, saveResult, type Run } from "./run.js";

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-restore-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

async function project(files: Record<string, string>): Promise<string> {
  const dir = await tree(files);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

describe("restore points", () => {
  it("lists every change since the point — edited, created, deleted — with diffs", async () => {
    const home = await tree({});
    const dir = await project({ "CLAUDE.md": "- one\n- two\n", ".claude/rules/a.md": "- rule a\n", ".claude/rules/b.md": "- rule b\n" });
    const point = await createRestorePoint(dir, { home });

    await writeFile(join(dir, "CLAUDE.md"), "- one\n- three\n");
    await mkdir(join(dir, "packages/api"), { recursive: true });
    await writeFile(join(dir, "packages/api/AGENTS.md"), "- api\n");
    await rm(join(dir, ".claude/rules/b.md"));

    const { changes } = await changesSince(point.id, dir, { home });
    expect(changes.map(change => [change.label, change.status])).toEqual([
      [".claude/rules/b.md", "deleted"],
      ["CLAUDE.md", "modified"],
      ["packages/api/AGENTS.md", "created"],
    ]);
    const edited = changes.find(change => change.label === "CLAUDE.md")!;
    expect(edited.diff).toContain("-- two");
    expect(edited.diff).toContain("+- three");
  });

  it("puts everything back byte for byte, keeps a symlink a symlink, and can be reversed", async () => {
    const home = await tree({});
    const dir = await project({ "CLAUDE.md": "- keep me\n", ".claude/rules/a.md": "- rule a\n" });
    await symlink("CLAUDE.md", join(dir, "AGENTS.md"));
    const original = await readFile(join(dir, "CLAUDE.md"), "utf8");
    const point = await createRestorePoint(dir, { home });

    await writeFile(join(dir, "CLAUDE.md"), "- rewritten\n");
    await rm(join(dir, ".claude/rules/a.md"));
    await writeFile(join(dir, ".claude/rules/new.md"), "- added\n");

    const outcome = await restoreTo(point.id, dir, { home });
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(original);
    expect(await readFile(join(dir, ".claude/rules/a.md"), "utf8")).toBe("- rule a\n");
    expect(await exists(join(dir, ".claude/rules/new.md"))).toBe(false);
    expect(await readlink(join(dir, "AGENTS.md"))).toBe("CLAUDE.md");
    expect(outcome.removed).toEqual([".claude/rules/new.md"]);
    expect(outcome.failed).toEqual([]);

    // The restore took a point of what it replaced, so it can be undone.
    await restoreTo(outcome.reverseWith, dir, { home });
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe("- rewritten\n");
    expect(await readFile(join(dir, ".claude/rules/new.md"), "utf8")).toBe("- added\n");
  });

  it("measures a session against one open point, closed once restored", async () => {
    const home = await tree({});
    const dir = await project({ "CLAUDE.md": "- a\n" });
    expect(await openRestorePoint(dir, { home })).toBeNull();
    const point = await createRestorePoint(dir, { home });
    expect(await openRestorePoint(dir, { home })).toBe(point.id);
    await restoreTo(point.id, dir, { home });
    expect(await openRestorePoint(dir, { home })).toBeNull();
  });

  it("lets a point expire after a week", async () => {
    const home = await tree({});
    const dir = await project({ "CLAUDE.md": "- a\n" });
    const point = await createRestorePoint(dir, { home, now: new Date("2026-01-01T00:00:00Z") });
    expect(await openRestorePoint(dir, { home, now: Date.parse("2026-01-05T00:00:00Z") })).toBe(point.id);
    expect(await openRestorePoint(dir, { home, now: Date.parse("2026-01-09T00:00:00Z") })).toBeNull();
  });

  it("never removes a file it could not capture, or one too large to be an instruction file", async () => {
    const home = await tree({});
    const dir = await project({ "CLAUDE.md": "- a\n", ".claude/skills/big/notes.md": "x".repeat(1_100_000) });
    const point = await createRestorePoint(dir, { home });
    const outcome = await restoreTo(point.id, dir, { home });
    expect(outcome.removed).toEqual([]);
    expect(await exists(join(dir, ".claude/skills/big/notes.md"))).toBe(true);
  });

  it("is kept apart from read-only runs when old runs are pruned", async () => {
    const home = await tree({});
    const dir = await project({ "CLAUDE.md": "- a\n" });
    const point = await createRestorePoint(dir, { home, now: new Date("2026-01-01T00:00:00Z") });
    for (let i = 0; i < 12; i++) {
      const id = `20260102-0000${String(i).padStart(2, "0")}-abcdef`;
      const runDir = join(home, ".config", "gradient", "runs", id);
      await mkdir(join(runDir, "snapshots"), { recursive: true });
      const run: Run = { id, dir: runDir, startedAt: "2026-01-02T00:00:00.000Z", home };
      await saveResult(run, { runId: id, startedAt: run.startedAt, applied: [], skipped: [], wrote: {} });
    }
    await pruneRuns({ home });
    expect((await loadResult(point.id, home))?.restorePoint).toBeDefined();
  });
});
