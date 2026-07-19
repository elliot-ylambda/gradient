import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { projectCacheDir } from "../config.js";

export const LIVE_MS = 600_000;
export const IDLE_MS = 3_600_000;
export const EDITING_CAP = 5;
export const TOOL_EVENT_WINDOW = 20;
export const DIGEST_LINE_CAP = 25;
export const REFRESH_FLOOR_MS = 30_000;
export const SEEN_TTL_MS = 604_800_000;
export const PR_CACHE_FRESH_MS = 300_000;
export const GH_TIMEOUT_MS = 2_000;
const GIT_TIMEOUT_MS = 5_000;

const execFileP = promisify(execFile);

/** Trimmed stdout, or null on any failure (no git, not a repo, timeout). */
export async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1_000_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface RepoLocation {
  /** Realpath of the main checkout — parent of the git common dir. All worktrees share it. */
  root: string;
  /** Realpath of this checkout's top level; equals root in the main checkout. */
  toplevel: string;
}

export async function locateRepo(dir: string): Promise<RepoLocation | null> {
  const toplevel = await git(["rev-parse", "--show-toplevel"], dir);
  if (!toplevel) return null;
  const common = await git(["rev-parse", "--git-common-dir"], dir);
  if (!common) return null;
  try {
    return {
      root: await realpath(dirname(resolve(dir, common))),
      toplevel: await realpath(toplevel),
    };
  } catch {
    return null;
  }
}

export async function resolveBoardRoot(dir: string): Promise<string | null> {
  return (await locateRepo(dir))?.root ?? null;
}

export function boardStateDir(boardRoot: string, home?: string): string {
  return join(projectCacheDir(boardRoot, home), "board");
}
