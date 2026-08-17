import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginRun,
  loadResult,
  newRunId,
  pruneRuns,
  runDir,
  runsDir,
  saveResult,
  sha256,
  snapshot,
  undoRun,
  withLock,
} from "./run.js";

const home = () => mkdtemp(join(tmpdir(), "grad-run-home-"));
const project = () => mkdtemp(join(tmpdir(), "grad-run-proj-"));

describe("newRunId", () => {
  it("is sortable, unique, and safe as a path segment", () => {
    const a = newRunId(new Date("2026-08-13T22:10:05Z"), "aaaaaa");
    const b = newRunId(new Date("2026-08-13T22:10:06Z"), "bbbbbb");
    expect(a).toBe("20260813-221005-aaaaaa");
    expect(a < b).toBe(true);
    expect(a).toMatch(/^[0-9a-f-]+$/);
  });
});

describe("beginRun", () => {
  it("creates a private run directory outside the repository", async () => {
    const h = await home();
    const run = await beginRun({ home: h });
    expect(run.dir.startsWith(runsDir(h))).toBe(true);
    expect((await stat(run.dir)).mode & 0o777).toBe(0o700);
  });
});

describe("withLock", () => {
  it("runs the body and releases afterwards", async () => {
    const h = await home();
    expect(await withLock(async () => "done", { home: h })).toBe("done");
    expect(await withLock(async () => "again", { home: h })).toBe("again");
  });

  it("refuses a second holder while a live one has it", async () => {
    const h = await home();
    await expect(withLock(async () => {
      await withLock(async () => "inner", { home: h });
    }, { home: h })).rejects.toThrow(/another gradient run/);
  });

  it("reclaims a lock older than the stale window", async () => {
    const h = await home();
    await mkdir(runsDir(h), { recursive: true });
    await writeFile(
      join(runsDir(h), ".lock"),
      JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 3_600_000).toISOString() }),
    );
    expect(await withLock(async () => "taken", { home: h })).toBe("taken");
  });

  it("reclaims a lock whose owner is gone", async () => {
    const h = await home();
    await mkdir(runsDir(h), { recursive: true });
    // A pid that cannot exist: max pid is well below this on every platform.
    await writeFile(
      join(runsDir(h), ".lock"),
      JSON.stringify({ pid: 2 ** 30, startedAt: new Date().toISOString() }),
    );
    expect(await withLock(async () => "taken", { home: h })).toBe("taken");
  });

  it("releases the lock even when the body throws", async () => {
    const h = await home();
    await expect(withLock(async () => { throw new Error("boom"); }, { home: h })).rejects.toThrow("boom");
    expect(await withLock(async () => "free", { home: h })).toBe("free");
  });
});

describe("snapshot and undoRun", () => {
  it("restores a file byte-for-byte", async () => {
    const h = await home();
    const p = await project();
    const file = join(p, "CLAUDE.md");
    const original = "# Original\n\n- keep this exactly\n";
    await writeFile(file, original);

    const run = await beginRun({ home: h });
    await snapshot(run, file, p);
    await writeFile(file, "# Rewritten\n");
    await saveResult(run, {
      runId: run.id, startedAt: run.startedAt, applied: [], skipped: [],
      wrote: { [file]: sha256("# Rewritten\n") },
    });

    const outcome = await undoRun(run.id, { home: h });
    expect(outcome.restored).toEqual([file]);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("keeps the first snapshot when a run writes the same file twice", async () => {
    const h = await home();
    const p = await project();
    const file = join(p, "CLAUDE.md");
    await writeFile(file, "original\n");

    const run = await beginRun({ home: h });
    await snapshot(run, file, p);
    await writeFile(file, "first edit\n");
    await snapshot(run, file, p); // must not capture the already-edited content
    await writeFile(file, "second edit\n");
    await saveResult(run, {
      runId: run.id, startedAt: run.startedAt, applied: [], skipped: [],
      wrote: { [file]: sha256("second edit\n") },
    });

    await undoRun(run.id, { home: h });
    expect(await readFile(file, "utf8")).toBe("original\n");
  });

  it("removes a file the run created rather than restoring empty content", async () => {
    const h = await home();
    const p = await project();
    const file = join(p, "AGENTS.md");

    const run = await beginRun({ home: h });
    await snapshot(run, file, p); // does not exist yet
    await writeFile(file, "created by the run\n");
    await saveResult(run, {
      runId: run.id, startedAt: run.startedAt, applied: [], skipped: [],
      wrote: { [file]: sha256("created by the run\n") },
    });

    await undoRun(run.id, { home: h });
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  // Undo must never be the thing that loses work.
  it("refuses to restore a file that changed again after the run", async () => {
    const h = await home();
    const p = await project();
    const file = join(p, "CLAUDE.md");
    await writeFile(file, "original\n");

    const run = await beginRun({ home: h });
    await snapshot(run, file, p);
    await writeFile(file, "by gradient\n");
    await saveResult(run, {
      runId: run.id, startedAt: run.startedAt, applied: [], skipped: [],
      wrote: { [file]: sha256("by gradient\n") },
    });
    await writeFile(file, "by a human, afterwards\n");

    const outcome = await undoRun(run.id, { home: h });
    expect(outcome.conflicted).toEqual([file]);
    expect(outcome.restored).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("by a human, afterwards\n");
  });

  it("reports an unknown run rather than silently doing nothing", async () => {
    await expect(undoRun("20260101-000000-abcdef", { home: await home() })).rejects.toThrow(/no such run/);
  });
});

describe("pruneRuns", () => {
  it("keeps the newest runs and drops the rest", async () => {
    const h = await home();
    for (let i = 0; i < 14; i++) {
      await mkdir(join(runDir(`2026081${i % 10}-00000${i % 10}-aaaaa${i}`, h), "snapshots"), { recursive: true });
    }
    const dropped = await pruneRuns({ home: h, keep: 10 });
    expect(dropped).toHaveLength(4);
  });

  it("ignores directories that are not run ids", async () => {
    const h = await home();
    await mkdir(join(runsDir(h), "not-a-run"), { recursive: true });
    expect(await pruneRuns({ home: h, keep: 0 })).toEqual([]);
  });
});

describe("saveResult and loadResult", () => {
  it("round-trips a run result", async () => {
    const h = await home();
    const run = await beginRun({ home: h });
    await saveResult(run, {
      runId: run.id, startedAt: run.startedAt,
      applied: [{ id: "a1", title: "did a thing", paths: ["/p/CLAUDE.md"] }],
      skipped: [{ id: "b2", reason: "edits prose a person wrote" }],
      wrote: {},
    });
    const loaded = await loadResult(run.id, h);
    expect(loaded?.applied[0].title).toBe("did a thing");
    expect(loaded?.skipped[0].reason).toContain("prose");
  });
});
