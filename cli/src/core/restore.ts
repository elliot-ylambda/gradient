import { execFile } from "node:child_process";
import { lstat, opendir, readlink, unlink } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { projectKey } from "../config.js";
import { assistantHomes, projectRoot, within, type DiscoveryOptions } from "./discovery.js";
import { repoIndex } from "./staleness.js";
import {
  beginRun,
  captureFile,
  isRunId,
  listDir,
  loadResult,
  loadSnapshot,
  restoreFile,
  runDir,
  runsDir,
  saveResult,
  snapshot,
  type RestorePointRecord,
  type Run,
  type RunResult,
  type Snapshot,
} from "./run.js";
import { safeSymlink, safeWriteFile } from "./safeFs.js";
import { redact } from "./security.js";

/**
 * A restore point: the instruction surface of one project, as it was before
 * anything changed it.
 *
 * `--undo` reverses one `--apply`. A restore point covers a whole session —
 * several applies, and the edits an assistant makes itself when it rewrites a
 * CLAUDE.md or AGENTS.md — so the user can see everything that changed since
 * (`--changes`) and put all of it back (`--restore`). Restoring first takes a
 * restore point of the state it replaces, so a restore can be reversed too.
 *
 * Captured: the instruction files both assistants load (every CLAUDE.md,
 * CLAUDE.local.md, AGENTS.md and AGENTS.override.md in the repository, and the
 * user-level ones), their settings, and the text files of every rules, skills,
 * commands and agents directory. Never followed: symbolic links, which are
 * recorded as links and recreated.
 */

const INSTRUCTION_NAMES: ReadonlySet<string> = new Set(["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md"]);
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".json", ".toml", ".yaml", ".yml", ".txt"]);
const MAX_FILES = 2_000;
const MAX_BYTES = 20_000_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_DEPTH = 6;
const OPEN_FOR_MS = 7 * 24 * 60 * 60_000;
const MAX_RUNS_SCANNED = 500;

export interface Location { path: string; base: string }

export interface RestoreTargets {
  root: string;
  files: Location[];
  dirs: Location[];
}

/** What a restore point covers for this project, on this machine. */
export async function restoreTargets(projectDir: string, opts: DiscoveryOptions = {}): Promise<RestoreTargets> {
  const root = await projectRoot(projectDir);
  const homes = assistantHomes(opts);
  const files: Location[] = [
    ...[...INSTRUCTION_NAMES, ".claude/CLAUDE.md", ".claude/settings.json", ".claude/settings.local.json"]
      .map(name => ({ path: join(root, name), base: root })),
    // User level: only what a checkup or a rewrite edits. Other tools write
    // ~/.claude/settings.json and user skill folders on their own schedule,
    // and a restore must not roll those back.
    { path: join(homes.claude, "CLAUDE.md"), base: homes.claude },
    ...["AGENTS.md", "AGENTS.override.md", "config.toml"].map(name => ({ path: join(homes.codex, name), base: homes.codex })),
  ];
  // Nested instruction files anywhere in the repository: a rewrite may split
  // a long AGENTS.md into per-directory ones.
  for (const file of await repoIndex(root) ?? []) {
    if (INSTRUCTION_NAMES.has(basename(file)) && file.includes("/")) files.push({ path: join(root, file), base: root });
  }
  const dirs: Location[] = [
    ...[".claude/rules", ".claude/skills", ".claude/commands", ".claude/agents", ".agents/skills", ".codex"]
      .map(name => ({ path: join(root, name), base: root })),
    { path: join(homes.claude, "rules"), base: homes.claude },
  ];
  return { root, files: unique(files), dirs: unique(dirs) };
}

function unique(locations: Location[]): Location[] {
  return [...new Map(locations.map(location => [location.path, location])).values()];
}

async function kind(path: string): Promise<"file" | "link" | "dir" | "other" | null> {
  const stats = await lstat(path).catch(() => null);
  if (!stats) return null;
  if (stats.isSymbolicLink()) return "link";
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "dir";
  return "other";
}

/** Zero for a file that is not there. */
async function sizeOf(path: string): Promise<number> {
  return lstat(path).then(stats => stats.size, () => 0);
}

/** Text files under a directory, bounded; links and dot-entries are skipped
 *  (a link is recorded where it is named, never walked through). */
async function walk(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > MAX_DEPTH || out.length > MAX_FILES) return out;
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    return out;
  }
  for await (const entry of handle) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth + 1, out);
    else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name))) out.push(full);
  }
  return out;
}

/** Every file a restore point would capture now: the fixed list plus whatever
 *  the walked directories hold. */
async function currentFiles(targets: RestoreTargets): Promise<{ files: Location[]; links: Record<string, string> }> {
  const files: Location[] = [];
  const links: Record<string, string> = {};
  for (const location of targets.files) {
    const type = await kind(location.path);
    if (type === "link") links[location.path] = await readlink(location.path);
    else if (type === "file" || type === null) files.push(location);
  }
  for (const dir of targets.dirs) {
    if (await kind(dir.path) !== "dir") continue;
    for (const path of await walk(dir.path)) files.push({ path, base: dir.base });
  }
  // Too large to be an instruction file someone edits by hand: left out of
  // both sides, so a restore never mistakes one for a file created later.
  const sized: Location[] = [];
  for (const file of unique(files)) {
    if (await sizeOf(file.path) <= MAX_FILE_BYTES) sized.push(file);
  }
  return { files: sized, links };
}

/** Take a restore point for this project. */
export async function createRestorePoint(
  projectDir: string,
  opts: DiscoveryOptions & { now?: Date; reason?: RestorePointRecord["reason"] } = {},
): Promise<{ id: string; files: number; uncovered: string[] }> {
  const home = opts.home ?? homedir();
  const targets = await restoreTargets(projectDir, opts);
  const { files, links } = await currentFiles(targets);
  if (files.length > MAX_FILES) {
    throw new Error(`refusing to take a restore point of ${files.length} files (limit ${MAX_FILES}); nothing was changed`);
  }
  const run = await beginRun({ home, ...(opts.now ? { now: opts.now } : {}) });
  let bytes = 0;
  const captured: Location[] = [];
  const uncovered: string[] = [];
  for (const file of files) {
    bytes += await sizeOf(file.path);
    if (bytes > MAX_BYTES) throw new Error(`refusing to take a restore point over ${MAX_BYTES} bytes; nothing was changed`);
    try {
      await snapshot(run, file.path, file.base);
      captured.push(file);
    } catch {
      uncovered.push(file.path);
    }
  }
  await saveResult(run, {
    runId: run.id, startedAt: run.startedAt, applied: [], skipped: [], wrote: {},
    restorePoint: {
      project: projectKey(targets.root),
      reason: opts.reason ?? "checkpoint",
      files: captured,
      dirs: targets.dirs,
      links,
      ...(uncovered.length ? { uncovered } : {}),
    },
  });
  return { id: run.id, files: captured.length, uncovered };
}

/** The restore point a session's changes are measured against: the most recent
 *  one for this project, taken before a change, not yet restored, under a week old. */
export async function openRestorePoint(projectDir: string, opts: { home?: string; now?: number } = {}): Promise<string | null> {
  const home = opts.home ?? homedir();
  const project = projectKey(await projectRoot(projectDir));
  const ids = (await listDir(runsDir(home))).filter(isRunId).sort().reverse().slice(0, MAX_RUNS_SCANNED);
  const now = opts.now ?? Date.now();
  for (const id of ids) {
    const result = await loadResult(id, home);
    const point = result?.restorePoint;
    if (!point || point.project !== project) continue;
    if (point.restoredAt || point.reason === "restore") return null;
    return now - Date.parse(result.startedAt) <= OPEN_FOR_MS ? id : null;
  }
  return null;
}

export type ChangeStatus = "modified" | "created" | "deleted";

export interface FileChange {
  path: string;
  /** The trusted root the file is read and written under. */
  base: string;
  /** Path for display: relative inside the project, `~` under home. */
  label: string;
  status: ChangeStatus;
  diff: string;
}

function label(path: string, root: string, home: string): string {
  if (within(root, path)) return relative(root, path) || basename(path);
  if (path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
  return path;
}

async function loadPoint(id: string, home: string): Promise<{ result: RunResult; point: RestorePointRecord }> {
  const result = await loadResult(id, home);
  if (!result?.restorePoint) throw new Error(`no such restore point: ${id}`);
  return { result, point: result.restorePoint };
}

/** Unified diff of before → after, through git so nothing new is bundled.
 *  Empty when git is unavailable; the status still says what changed. */
async function unifiedDiff(
  before: string | null,
  afterPath: string | null,
  labels: { before: string; after: string },
  tmp: string,
  home: string,
): Promise<string> {
  const left = before === null ? "/dev/null" : join(tmp, "before");
  if (before !== null) await safeWriteFile(home, left, before, { mode: 0o600 });
  const right = afterPath ?? "/dev/null";
  const output = await new Promise<string>(resolve => {
    execFile("git", ["-c", "core.fsmonitor=false", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", left, right],
      { cwd: tmp, maxBuffer: 8_000_000, timeout: 10_000 },
      (error, stdout) => resolve(error && (error as { code?: unknown }).code !== 1 ? "" : String(stdout)));
  });
  if (before !== null) await unlink(left).catch(() => undefined);
  const hunks = output.slice(Math.max(0, output.indexOf("\n@@") + 1));
  // Settings and config files can hold tokens; a diff shown to a terminal or
  // an assistant gets the same redaction as every other Gradient output.
  return output.includes("@@") ? redact(`--- ${labels.before}\n+++ ${labels.after}\n${hunks}`) : "";
}

/** Everything that changed since a restore point, with diffs. */
export async function changesSince(
  id: string,
  projectDir: string,
  opts: DiscoveryOptions = {},
): Promise<{ id: string; takenAt: string; changes: FileChange[] }> {
  const home = opts.home ?? homedir();
  const { result, point } = await loadPoint(id, home);
  const targets = await restoreTargets(projectDir, opts);
  const displayHome = assistantHomes(opts).home;
  const captured = new Map(point.files.map(file => [file.path, file]));
  const current = new Map((await currentFiles({ ...targets, dirs: point.dirs })).files.map(file => [file.path, file]));
  const uncovered = new Set(point.uncovered ?? []);
  const tmp = join(runsDir(home), id, "diff");
  const changes: FileChange[] = [];
  const paths = [...new Set([...captured.keys(), ...current.keys()])].filter(path => !uncovered.has(path)).sort();
  for (const path of paths) {
    const location = captured.get(path) ?? current.get(path)!;
    const before: Snapshot | null = captured.has(path) ? await loadSnapshot(id, path, home) : null;
    const after = await captureFile(path, location.base).catch(() => null);
    const existedBefore = !!before?.existed;
    const existsNow = !!after?.existed;
    if (!existedBefore && !existsNow) continue;
    if (existedBefore && existsNow && before!.sha256 === after!.sha256) continue;
    let status: ChangeStatus = "modified";
    if (!existedBefore) status = "created";
    else if (!existsNow) status = "deleted";
    const name = label(path, targets.root, displayHome);
    changes.push({
      path, base: location.base, label: name, status,
      diff: await unifiedDiff(existedBefore ? before!.content : null, existsNow ? path : null,
        { before: `${name} (restore point)`, after: `${name} (now)` }, tmp, home),
    });
  }
  for (const [path, target] of Object.entries(point.links)) {
    const linkedTo = await kind(path) === "link" ? await readlink(path) : null;
    if (linkedTo === target) continue;
    const base = targets.files.find(file => file.path === path)?.base ?? targets.root;
    changes.push({
      path, base, label: label(path, targets.root, displayHome), status: "modified",
      diff: redact(`link ${target} → ${linkedTo ?? "(not a link now)"}\n`),
    });
  }
  return { id, takenAt: result.startedAt, changes };
}

/** Put the project's instruction surface back the way a restore point found
 *  it. Takes a restore point of the current state first, so this is reversible. */
export async function restoreTo(
  id: string,
  projectDir: string,
  opts: DiscoveryOptions & { now?: Date } = {},
): Promise<{ restored: string[]; removed: string[]; failed: string[]; reverseWith: string }> {
  const home = opts.home ?? homedir();
  const { result, point } = await loadPoint(id, home);
  const { changes } = await changesSince(id, projectDir, opts);
  const reverse = await createRestorePoint(projectDir, { ...opts, reason: "restore" });
  const restored: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];
  for (const change of changes) {
    try {
      const linkTarget = point.links[change.path];
      if (linkTarget !== undefined) {
        // Replaced in one rename; a linked ancestor directory is refused.
        await safeSymlink(change.base, linkTarget, change.path);
        restored.push(change.label);
        continue;
      }
      const record = await loadSnapshot(id, change.path, home);
      if (change.status === "created" || !record) {
        await restoreFile({ path: change.path, base: change.base, sha256: "", content: "", existed: false });
        removed.push(change.label);
      } else {
        await restoreFile(record);
        restored.push(change.label);
      }
    } catch {
      // Left as it is now and reported; the reverse restore point still has it.
      failed.push(change.label);
    }
  }
  const run: Run = { id, dir: runDir(id, home), startedAt: result.startedAt, home };
  await saveResult(run, { ...result, restorePoint: { ...point, restoredAt: new Date().toISOString() } });
  return { restored, removed, failed, reverseWith: reverse.id };
}

/** What one `--apply` run changed, file by file, as diffs from its own
 *  snapshots — so applying shows the change, not just the file name. */
export async function diffRun(runId: string, paths: string[], projectDir: string, opts: DiscoveryOptions = {}): Promise<Record<string, string>> {
  const home = opts.home ?? homedir();
  const root = await projectRoot(projectDir);
  const tmp = join(runsDir(home), runId, "diff");
  const out: Record<string, string> = {};
  for (const path of paths) {
    const before = await loadSnapshot(runId, path, home).catch(() => null);
    if (!before) continue;
    const exists = await kind(path) === "file";
    const name = label(path, root, assistantHomes(opts).home);
    const diff = await unifiedDiff(before.existed ? before.content : null, exists ? path : null,
      { before: `${name} (before)`, after: `${name} (now)` }, tmp, home);
    if (diff) out[path] = diff;
  }
  return out;
}
