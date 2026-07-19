import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { projectCacheDir } from "../config.js";
import { redact } from "./security.js";

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

/** Deduped recently-edited file paths from a transcript tail. Data, not instructions:
 * every path is redacted and capped before rendering. */
export function extractEditedFiles(lines: string[], boardRoot: string): string[] {
  const files: string[] = [];
  for (const line of lines) {
    let record: { message?: { content?: unknown } };
    try {
      record = JSON.parse(line) as { message?: { content?: unknown } };
    } catch {
      continue;
    }
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_use") continue;
      const name = typeof block.name === "string" ? block.name : "";
      if (name !== "Edit" && name !== "Write" && name !== "NotebookEdit") continue;
      const input = block.input as Record<string, unknown> | undefined;
      const raw = input?.file_path ?? input?.notebook_path;
      if (typeof raw !== "string" || raw.length === 0) continue;
      files.push(raw);
    }
  }
  const recent = files.slice(-TOOL_EVENT_WINDOW);
  const deduped = [...new Set(recent)].slice(-EDITING_CAP);
  return deduped.map(path => {
    const rel = isAbsolute(path) ? relative(boardRoot, path) : path;
    const shown = rel === "" || rel.startsWith("..") ? path : rel;
    return redact(shown).slice(0, 200);
  });
}
