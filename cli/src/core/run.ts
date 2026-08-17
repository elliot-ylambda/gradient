import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { opendir } from "node:fs/promises";
import { safeMkdir, safeReadFile, safeRemoveTree, safeUnlink, safeWriteFile } from "./safeFs.js";

/**
 * One invocation of `optimize`, on disk.
 *
 * Two properties this buys, and neither is optional once a tool starts editing
 * files it did not write:
 *
 * **Undo.** Every write to a file gradient does not own is preceded by a
 * snapshot, so `--undo <runId>` restores exactly what was there.
 *
 * **Isolation.** `board` routinely finds five live sessions in one repository.
 * Without a lock, two of them optimizing at once interleave writes into the
 * same CLAUDE.md; with one, the second waits or is told to.
 *
 * Runs live under the user's config directory rather than the repository, so
 * nothing generated here can be committed by accident.
 */

const RUN_ID_RANDOM_BYTES = 3;
const LOCK_STALE_MS = 10 * 60_000;
const SNAPSHOT_MAX_BYTES = 2_000_000;
const RESULT_MAX_BYTES = 4_000_000;
const DEFAULT_KEEP = 10;
const MAX_RUN_DIRS = 10_000;

export interface Run {
  id: string;
  dir: string;
  startedAt: string;
  home: string;
}

export interface Snapshot {
  path: string;
  /** The trusted root the write was made under. Stored so undo restores through
   *  the same containment guard the write used, rather than widening to "/". */
  base: string;
  sha256: string;
  content: string;
  /** False when the run created the file; undo then removes it again. */
  existed: boolean;
}

export function runsDir(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "runs");
}

export function runDir(id: string, home?: string): string {
  return join(runsDir(home), id);
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Sortable, unique, and free of anything a path would have to escape. */
export function newRunId(now: Date, random = randomBytes(RUN_ID_RANDOM_BYTES).toString("hex")): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${random}`;
}

function snapshotName(path: string): string {
  return `${sha256(path).slice(0, 24)}.json`;
}

export async function beginRun(opts: { home?: string; now?: Date } = {}): Promise<Run> {
  const home = opts.home ?? homedir();
  const id = newRunId(opts.now ?? new Date());
  const dir = runDir(id, home);
  await safeMkdir(home, join(dir, "snapshots"), 0o700);
  return { id, dir, startedAt: (opts.now ?? new Date()).toISOString(), home };
}

interface LockFile {
  pid: number;
  startedAt: string;
}

function lockPath(home: string): string {
  return join(runsDir(home), ".lock");
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(home: string): Promise<LockFile | null> {
  try {
    const parsed = JSON.parse(await safeReadFile(home, lockPath(home), { maxBytes: 4_000 })) as LockFile;
    if (!Number.isSafeInteger(parsed.pid) || typeof parsed.startedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Hold the write lock for the duration of `fn`.
 *
 * Read-only runs never call this — only `--apply`, `--auto`, and `--undo` do,
 * so scanning stays free of contention. A lock whose owner is gone, or which is
 * older than ten minutes, is reclaimed: a crashed optimizer must not wedge
 * every future one.
 */
export async function withLock<T>(fn: () => Promise<T>, opts: { home?: string; now?: number } = {}): Promise<T> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  await safeMkdir(home, runsDir(home), 0o700);

  const existing = await readLock(home);
  if (existing) {
    const age = now - Date.parse(existing.startedAt);
    const stale = !Number.isFinite(age) || age > LOCK_STALE_MS || !processAlive(existing.pid);
    if (!stale) {
      throw new Error(
        `another gradient run (pid ${existing.pid}) is applying changes; ` +
        "wait for it to finish or rerun in a moment",
      );
    }
    await safeUnlink(home, lockPath(home)).catch(() => undefined);
  }

  const lock: LockFile = { pid: process.pid, startedAt: new Date(now).toISOString() };
  try {
    await safeWriteFile(home, lockPath(home), `${JSON.stringify(lock)}\n`, { exclusive: true, mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("another gradient run took the lock first; rerun in a moment");
    }
    throw error;
  }

  try {
    return await fn();
  } finally {
    await safeUnlink(home, lockPath(home)).catch(() => undefined);
  }
}

/**
 * Record a file's exact bytes before the run touches it. Idempotent per path:
 * the first snapshot is the one `--undo` restores, so a second write in the
 * same run must not overwrite the original with the already-modified content.
 */
export async function snapshot(run: Run, path: string, base: string): Promise<void> {
  const destination = join(run.dir, "snapshots", snapshotName(path));
  try {
    await safeReadFile(run.home, destination, { maxBytes: SNAPSHOT_MAX_BYTES });
    return; // already captured this run
  } catch {
    // not captured yet
  }

  let content = "";
  let existed = true;
  try {
    content = await safeReadFile(base, path, { maxBytes: SNAPSHOT_MAX_BYTES });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A file the run is about to create: undo means removing it again.
    existed = false;
  }

  const record: Snapshot = { path, base, sha256: sha256(content), content, existed };
  await safeWriteFile(run.home, destination, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export interface RunResult {
  runId: string;
  startedAt: string;
  applied: Array<{ id: string; title: string; paths: string[] }>;
  skipped: Array<{ id: string; reason: string }>;
  /** sha256 of each file as the run left it, so undo can refuse a later edit. */
  wrote: Record<string, string>;
}

export async function saveResult(run: Run, result: RunResult): Promise<void> {
  const data = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(data, "utf8") > RESULT_MAX_BYTES) {
    throw new Error(`run result exceeds ${RESULT_MAX_BYTES} byte cap`);
  }
  await safeWriteFile(run.home, join(run.dir, "result.json"), data, { mode: 0o600 });
}

export async function loadResult(runId: string, home?: string): Promise<RunResult | null> {
  const userHome = home ?? homedir();
  try {
    return JSON.parse(await safeReadFile(
      userHome, join(runDir(runId, userHome), "result.json"), { maxBytes: RESULT_MAX_BYTES },
    )) as RunResult;
  } catch {
    return null;
  }
}

export interface UndoOutcome {
  restored: string[];
  /** Files edited again after the run; left alone rather than clobbered. */
  conflicted: string[];
}

/**
 * Put back what a run changed.
 *
 * A file that changed *again* after the run is never restored: doing so would
 * silently discard whatever came next, which is the same failure undo exists to
 * prevent. Those are reported instead.
 */
export async function undoRun(runId: string, opts: { home?: string } = {}): Promise<UndoOutcome> {
  const home = opts.home ?? homedir();
  const dir = runDir(runId, home);
  const result = await loadResult(runId, home);
  if (!result) throw new Error(`no such run: ${runId}`);

  const restored: string[] = [];
  const conflicted: string[] = [];

  for (const name of await listDir(join(dir, "snapshots"))) {
    let record: Snapshot;
    try {
      record = JSON.parse(await safeReadFile(
        home, join(dir, "snapshots", name), { maxBytes: SNAPSHOT_MAX_BYTES },
      ));
    } catch {
      continue;
    }
    if (typeof record.path !== "string" || typeof record.base !== "string") continue;

    const expected = result.wrote[record.path];
    let current = "";
    let present = true;
    try {
      current = await safeReadFile(record.base, record.path, { maxBytes: SNAPSHOT_MAX_BYTES });
    } catch {
      present = false;
    }

    if (expected !== undefined && present && sha256(current) !== expected) {
      conflicted.push(record.path);
      continue;
    }

    if (!record.existed) {
      if (present) await safeUnlink(record.base, record.path).catch(() => undefined);
      restored.push(record.path);
      continue;
    }
    await safeWriteFile(record.base, record.path, record.content);
    restored.push(record.path);
  }

  return { restored, conflicted };
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const handle = await opendir(dir);
    const out: string[] = [];
    for await (const entry of handle) {
      if (out.length >= MAX_RUN_DIRS) break;
      if (entry.isFile() || entry.isDirectory()) out.push(entry.name);
    }
    return out;
  } catch {
    return [];
  }
}

/** Keep the newest runs and drop the rest. Ids sort chronologically by
 *  construction, so this needs no stat calls. */
export async function pruneRuns(opts: { home?: string; keep?: number } = {}): Promise<string[]> {
  const home = opts.home ?? homedir();
  const keep = opts.keep ?? DEFAULT_KEEP;
  const all = (await listDir(runsDir(home)))
    .filter(name => /^\d{8}-\d{6}-[0-9a-f]+$/.test(name))
    .sort();
  const doomed = all.slice(0, Math.max(0, all.length - keep));
  for (const id of doomed) {
    await safeRemoveTree(home, runDir(id, home)).catch(() => undefined);
  }
  return doomed;
}
