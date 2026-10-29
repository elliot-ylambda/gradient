import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, opendir } from "node:fs/promises";
import { safeMkdir, safeReadFile, safeRemoveTree, safeUnlink, safeWriteFile } from "./safeFs.js";
import type { Assistant, ManifestEntry } from "./types.js";

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
const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6,32}$/;

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
  mode?: number;
}

export function runsDir(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "runs");
}

export function runDir(id: string, home?: string): string {
  if (!RUN_ID_PATTERN.test(id)) throw new Error("invalid run id");
  return join(runsDir(home), id);
}

const EMPTY_SHA256 = sha256("");

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
 * Used for apply, undo, decisions, and the brief daily-check claim. Scanning
 * itself stays outside the lock. A lock whose owner is gone, or which is
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

  const record = await captureFile(path, base);
  const encoded = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > SNAPSHOT_MAX_BYTES) {
    throw new Error(`cannot safely snapshot ${path}: encoded snapshot exceeds ${SNAPSHOT_MAX_BYTES} byte limit`);
  }
  await safeWriteFile(run.home, destination, encoded, { mode: 0o600 });
}

async function captureFile(path: string, base: string): Promise<Snapshot> {
  try {
    const content = await safeReadFile(base, path, { maxBytes: SNAPSHOT_MAX_BYTES });
    const mode = (await lstat(path)).mode & 0o777;
    return { path, base, sha256: sha256(content), content, existed: true, mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path, base, sha256: EMPTY_SHA256, content: "", existed: false };
  }
}

async function restoreFile(record: Snapshot): Promise<void> {
  if (record.existed) {
    await safeWriteFile(record.base, record.path, record.content, { mode: record.mode ?? 0o600 });
  } else {
    await safeUnlink(record.base, record.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

/** Capture the complete effect of one finding, including its private bookkeeping.
 * A failed target rolls back this finding to its immediate starting state;
 * the run snapshots still retain the state before any earlier findings. */
export async function withFileTransaction<T>(
  run: Run,
  files: Array<{ path: string; base: string; bookkeeping?: boolean }>,
  action: () => Promise<T>,
): Promise<{ value: T; wrote: RunResult["wrote"] }> {
  const unique = [...new Map(files.map(file => [file.path, file])).values()];
  const before: Snapshot[] = [];
  for (const file of unique) {
    before.push(await captureFile(file.path, file.base));
    // Shared bookkeeping is rolled back on failure but never restored whole by
    // undo: a later apply or `gradient on|off` rewrites the same file.
    if (!file.bookkeeping) await snapshot(run, file.path, file.base);
  }
  const bookkeeping = new Set(unique.filter(file => file.bookkeeping).map(file => file.path));
  try {
    const value = await action();
    const wrote: RunResult["wrote"] = {};
    for (const prior of before) {
      if (bookkeeping.has(prior.path)) continue;
      const after = await captureFile(prior.path, prior.base);
      if (after.existed !== prior.existed || after.sha256 !== prior.sha256) {
        wrote[prior.path] = after.existed ? after.sha256 : null;
      }
    }
    return { value, wrote };
  } catch (error) {
    const failures: string[] = [];
    for (const prior of before.reverse()) {
      try {
        const current = await captureFile(prior.path, prior.base);
        if (current.existed !== prior.existed || current.sha256 !== prior.sha256) await restoreFile(prior);
      } catch {
        failures.push(prior.path);
      }
    }
    if (failures.length) {
      throw new Error(`${(error as Error).message}; rollback could not restore: ${failures.join(", ")}`);
    }
    throw error;
  }
}

export interface RunResult {
  runId: string;
  startedAt: string;
  applied: Array<{ id: string; title: string; paths: string[] }>;
  skipped: Array<{ id: string; reason: string }>;
  /** sha256 of each file as the run left it, so undo can refuse a later edit. */
  wrote: Record<string, string | null>;
  /** Manifest entries and consent this run added, reversed entry by entry. */
  bookkeeping?: BookkeepingRecord[];
  undoneAt?: string;
}

export interface BookkeepingRecord {
  projectDir: string;
  name: string;
  target: Assistant;
  suggestionId: string;
  /** The entry this run replaced, put back on undo. */
  prior: ManifestEntry | null;
  /** Whether this run granted continuity consent for the project. */
  consent: boolean;
}

function validBookkeeping(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 100 && value.every(record =>
    record && typeof record === "object" &&
    typeof record.projectDir === "string" && typeof record.name === "string" &&
    (record.target === "claude-code" || record.target === "codex") &&
    typeof record.suggestionId === "string" && typeof record.consent === "boolean" &&
    (record.prior === null || (typeof record.prior === "object" && !Array.isArray(record.prior))));
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
    const value = JSON.parse(await safeReadFile(
      runsDir(userHome), join(runDir(runId, userHome), "result.json"), { maxBytes: RESULT_MAX_BYTES },
    ));
    if (!value || value.runId !== runId || typeof value.startedAt !== "string" ||
      !Number.isFinite(Date.parse(value.startedAt)) || !Array.isArray(value.applied) || !Array.isArray(value.skipped) ||
      !value.wrote || typeof value.wrote !== "object" || Array.isArray(value.wrote) ||
      !Object.values(value.wrote).every(hash => hash === null || typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) ||
      !validBookkeeping(value.bookkeeping)) return null;
    return value as RunResult;
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
export async function undoRun(
  runId: string,
  opts: { home?: string; reverseBookkeeping?: (records: BookkeepingRecord[]) => Promise<void> } = {},
): Promise<UndoOutcome> {
  const home = opts.home ?? homedir();
  const dir = runDir(runId, home);
  const result = await loadResult(runId, home);
  if (!result) throw new Error(`no such run: ${runId}`);
  if (result.undoneAt) return { restored: [], conflicted: [] };

  const restored: string[] = [];
  const conflicted: string[] = [];
  const records: Snapshot[] = [];

  // Preflight the entire run before restoring anything. Restoring a manifest
  // while leaving a changed artifact (or the reverse) would corrupt ownership.
  for (const path of Object.keys(result.wrote)) {
    let record: Snapshot;
    try {
      let raw: string;
      try {
        raw = await safeReadFile(runsDir(home), join(dir, "snapshots", snapshotName(path)), { maxBytes: SNAPSHOT_MAX_BYTES });
      } catch (error) {
        // Runs before 0.10 recorded no-op changes without a snapshot. Nothing
        // was captured, so there is nothing to put back.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      record = JSON.parse(raw);
      if (record.path !== path || typeof record.base !== "string" || typeof record.content !== "string" ||
        typeof record.existed !== "boolean" || record.sha256 !== sha256(record.content) ||
        (record.mode !== undefined && (!Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o777))) {
        throw new Error("invalid snapshot");
      }
      const current = await captureFile(path, record.base);
      const expected = result.wrote[path];
      // Before 0.10 a deletion was recorded as the hash of empty content.
      const absent = expected === null || expected === EMPTY_SHA256;
      const matches = (absent && !current.existed) || (expected !== null && current.existed && current.sha256 === expected);
      if (!matches) conflicted.push(path);
      records.push(record);
    } catch {
      conflicted.push(path);
    }
  }
  if (conflicted.length) return { restored, conflicted };
  const run: Run = { id: runId, dir, startedAt: result.startedAt, home };
  await withFileTransaction(run, records, async () => {
    for (const record of records.reverse()) {
      await restoreFile(record);
      restored.push(record.path);
    }
    if (result.bookkeeping?.length) await opts.reverseBookkeeping?.(result.bookkeeping);
    await saveResult(run, { ...result, undoneAt: new Date().toISOString() });
  });

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

/** Retain applied runs separately: a dozen read-only checks must never evict
 * the undo record for the last approved repair. Both groups remain bounded. */
export async function pruneRuns(opts: { home?: string; keep?: number } = {}): Promise<string[]> {
  const home = opts.home ?? homedir();
  const keep = opts.keep ?? DEFAULT_KEEP;
  const all = (await listDir(runsDir(home)))
    .filter(name => RUN_ID_PATTERN.test(name))
    .sort();
  const applied: string[] = [];
  const proposals: string[] = [];
  for (const id of all) {
    const result = await loadResult(id, home);
    (result && Object.keys(result.wrote).length > 0 ? applied : proposals).push(id);
  }
  const doomed = [...applied.slice(0, Math.max(0, applied.length - keep)),
    ...proposals.slice(0, Math.max(0, proposals.length - keep))].sort();
  for (const id of doomed) {
    await safeRemoveTree(home, runDir(id, home)).catch(() => undefined);
  }
  return doomed;
}
