import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { assertNoSymlinkPath, symlinkRefusalError } from "./safeFs.js";

export interface CollectOptions {
  scope: "project" | "all";
  projectPath?: string;
  sinceDays?: number;
  now?: number;
  home?: string;
  onWarn?: (message: string) => void;
}

// Symlinked history roots are refused by design (safeFs hardening), but a
// dotfiles-managed ~/.claude or ~/.codex must not read as an empty history:
// surface each refused path once instead of failing silently.
export function symlinkWarner(onWarn?: (message: string) => void): (error: unknown) => void {
  const warned = new Set<string>();
  return error => {
    const failure = error as NodeJS.ErrnoException;
    if (!onWarn || failure?.code !== "ESYMLINK" || !failure.path || warned.has(failure.path)) return;
    warned.add(failure.path);
    onWarn(
      `coverage: ${failure.path} is a symlink — refusing to traverse it; ` +
      "replace it with a real directory to include its transcripts",
    );
  };
}

const TRANSCRIPT_DISCOVERY_CAP = 10_000;
const TRANSCRIPT_FILE_CAP = 5_000;
const TRANSCRIPT_TOTAL_BYTES_CAP = 512 * 1024 * 1024;
const TRANSCRIPT_FILE_BYTES_CAP = 8_000_000;
const TRANSCRIPT_TREE_DEPTH_CAP = 20;

/** The history root itself is the user's own config — a dotfiles-managed
 * ~/.claude or a root moved to another disk must work out of the box. Resolve
 * the root's own symlinks once; everything beneath it stays symlink-free. */
export async function canonicalRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path; // missing root — the walk turns into a no-op
  }
}

export function encodeProjectDir(cwd: string): string {
  // Claude's directory encoding replaces path separators. Cover both styles so
  // a Windows cwd can never turn the joined transcript root into a path escape.
  return cwd.replace(/[\\/]/g, "-").replace(/:/g, "-");
}

// Sessions started in Claude Code git worktrees transcribe into SIBLING directories named
// <encoded>--claude-worktrees-<branch>, not into the project's own directory, so a
// project-scoped scan that only reads the exact-match directory silently misses all
// worktree sessions. Sweep those siblings too.
async function projectRoots(
  base: string,
  projectsRoot: string,
  cwd: string,
  onRefused: (error: unknown) => void,
): Promise<string[]> {
  const encoded = encodeProjectDir(cwd);
  const exact = join(projectsRoot, encoded);
  let directory;
  try {
    await assertNoSymlinkPath(base, projectsRoot);
    directory = await opendir(projectsRoot);
  } catch (error) {
    onRefused(error);
    return [exact];
  }
  const worktreePrefix = `${encoded}--claude-worktrees-`;
  const roots: string[] = [];
  let seen = 0;
  for await (const entry of directory) {
    seen += 1;
    if (seen > TRANSCRIPT_DISCOVERY_CAP) break;
    if (entry.isDirectory() && (entry.name === encoded || entry.name.startsWith(worktreePrefix))) {
      roots.push(join(projectsRoot, entry.name));
    }
  }
  return roots.length ? roots : [exact];
}

export function matchesSince(mtimeMs: number, sinceDays: number | undefined, now: number): boolean {
  if (sinceDays === undefined) return true;
  return now - mtimeMs <= sinceDays * 86_400_000;
}

async function walk(
  base: string,
  dir: string,
  out: string[],
  onRefused: (error: unknown) => void,
  depth = 0,
): Promise<void> {
  if (depth > TRANSCRIPT_TREE_DEPTH_CAP || out.length >= TRANSCRIPT_DISCOVERY_CAP) return;
  let directory;
  try {
    await assertNoSymlinkPath(base, dir);
    directory = await opendir(dir);
  } catch (error) {
    onRefused(error);
    return;
  }
  for await (const entry of directory) {
    if (out.length >= TRANSCRIPT_DISCOVERY_CAP) break;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "subagents") continue; // exclude subagent transcripts
      await walk(base, full, out, onRefused, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    } else if (entry.isSymbolicLink()) {
      // Dirents never report a symlink as a directory or file, so traversal
      // skips them naturally — but the skip must be visible, not silent.
      onRefused(symlinkRefusalError(full));
    }
  }
}

export async function collect(opts: CollectOptions): Promise<string[]> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const projectsRoot = await canonicalRoot(join(home, ".claude", "projects"));
  const onRefused = symlinkWarner(opts.onWarn);
  let roots: string[];
  if (opts.scope === "all") {
    roots = [projectsRoot];
  } else {
    const cwd = opts.projectPath ?? process.cwd();
    roots = await projectRoots(projectsRoot, projectsRoot, cwd, onRefused);
  }
  const files: string[] = [];
  for (const root of roots) await walk(projectsRoot, root, files, onRefused);
  const candidates: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const path of files) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.size > TRANSCRIPT_FILE_BYTES_CAP) continue;
      if (matchesSince(metadata.mtimeMs, opts.sinceDays, now)) {
        candidates.push({ path, mtimeMs: metadata.mtimeMs, size: metadata.size });
      }
    } catch {
      // The transcript disappeared or changed type during discovery.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const kept: string[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (kept.length >= TRANSCRIPT_FILE_CAP || totalBytes + candidate.size > TRANSCRIPT_TOTAL_BYTES_CAP) break;
    kept.push(candidate.path);
    totalBytes += candidate.size;
  }
  return kept;
}
