import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { projectCacheDir } from "../config.js";
import { collectCodex, readCodexSessionMeta } from "./collect-codex.js";
import { safeMkdir, safeReadFile, safeWriteFile } from "./safeFs.js";
import { redact } from "./security.js";
import { readTranscriptLines } from "./tail.js";

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
const DISCOVERY_FILE_CAP = 500;

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

export type Liveness = "live" | "idle";

export interface BoardSession {
  agent: "claude" | "codex";
  sessionId: string;
  branch?: string;
  /** Checkout path relative to the board root; "" means the main checkout. */
  worktree: string;
  liveness: Liveness;
  ageMs: number;
  /** Recently edited files. Claude sessions only in v1; empty for Codex. */
  editing: string[];
}

export interface DiscoverOptions {
  home?: string;
  now?: number;
  /** One message per transcript skipped as unreadable; surfaced by `board --verbose`. */
  onWarn?: (message: string) => void;
}

export async function discoverClaudeSessions(
  boardRoot: string,
  opts: DiscoverOptions = {},
): Promise<BoardSession[]> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const projectsRoot = join(home, ".claude", "projects");
  let dirs: string[] = [];
  try {
    dirs = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => join(projectsRoot, entry.name));
  } catch {
    return [];
  }
  const sessions: BoardSession[] = [];
  let visited = 0;
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter(name => name.endsWith(".jsonl")).map(name => join(dir, name));
    } catch {
      continue;
    }
    for (const file of files) {
      if (++visited > DISCOVERY_FILE_CAP) return sessions;
      let ageMs: number;
      try {
        const stats = await lstat(file);
        if (!stats.isFile()) continue;
        ageMs = now - stats.mtimeMs;
      } catch {
        continue;
      }
      if (ageMs > IDLE_MS) continue;
      const session = await readClaudeSession(file, boardRoot, ageMs, opts.onWarn);
      if (session) sessions.push(session);
    }
  }
  return sessions;
}

async function readClaudeSession(
  file: string,
  boardRoot: string,
  ageMs: number,
  onWarn?: (message: string) => void,
): Promise<BoardSession | null> {
  let lines: string[];
  try {
    lines = await readTranscriptLines(file);
  } catch {
    onWarn?.(`board: skipped unreadable transcript ${basename(file)}`);
    return null;
  }
  let cwd: string | undefined;
  let branch: string | undefined;
  let sessionId: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof record.cwd !== "string" || !isAbsolute(record.cwd)) continue;
    if (record.isSidechain === true) return null; // subagent transcript
    cwd = record.cwd;
    if (typeof record.gitBranch === "string" && record.gitBranch.length > 0) {
      branch = record.gitBranch.slice(0, 500);
    }
    if (typeof record.sessionId === "string" && record.sessionId.length > 0) {
      sessionId = record.sessionId.slice(0, 200);
    }
    break;
  }
  if (!cwd || !sessionId) return null;
  const location = await locateRepo(cwd);
  if (!location || location.root !== boardRoot) return null;
  return {
    agent: "claude",
    sessionId,
    ...(branch ? { branch } : {}),
    worktree: relative(boardRoot, location.toplevel),
    liveness: ageMs <= LIVE_MS ? "live" : "idle",
    ageMs,
    editing: extractEditedFiles(lines, boardRoot),
  };
}

export async function discoverCodexSessions(
  boardRoot: string,
  opts: DiscoverOptions = {},
): Promise<BoardSession[]> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  let paths: string[] = [];
  try {
    paths = await collectCodex({ scope: "all", sinceDays: 1, now, home, onWarn: opts.onWarn });
  } catch {
    return [];
  }
  const sessions: BoardSession[] = [];
  for (const path of paths.slice(0, DISCOVERY_FILE_CAP)) {
    let ageMs: number;
    try {
      ageMs = now - (await lstat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs > IDLE_MS) continue;
    const meta = await readCodexSessionMeta(path);
    if (!meta || meta.subagent) continue;
    const location = await locateRepo(meta.cwd);
    if (!location || location.root !== boardRoot) continue;
    sessions.push({
      agent: "codex",
      sessionId: meta.sessionId,
      ...(meta.branch ? { branch: meta.branch } : {}),
      worktree: relative(boardRoot, location.toplevel),
      liveness: ageMs <= LIVE_MS ? "live" : "idle",
      ageMs,
      editing: [],
    });
  }
  return sessions;
}

const LANDED_CAP = 5;

export interface RepoState {
  defaultBranch: string;
  mainTip: string;
  landed: string[];
  ahead: number;
  behind: number;
}

/** `Merge pull request #16 from owner/spec/plugin` → `PR #16 spec/plugin`. */
export function landedLine(subject: string): string {
  const merge = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject);
  if (merge) return `PR #${merge[1]} ${redact(merge[2]).slice(0, 80)}`;
  return redact(subject).slice(0, 100);
}

export async function collectRepoState(
  boardRoot: string,
  sessionCwd: string,
): Promise<RepoState | null> {
  const defaultBranch =
    (await git(["rev-parse", "--verify", "--quiet", "main"], boardRoot)) !== null ? "main"
      : (await git(["rev-parse", "--verify", "--quiet", "master"], boardRoot)) !== null ? "master"
        : null;
  if (!defaultBranch) return null;
  const mainTip = (await git(["rev-parse", defaultBranch], boardRoot)) ?? "";
  const log = await git(
    ["log", defaultBranch, "--first-parent", "--since=24.hours", "--pretty=format:%s"],
    boardRoot,
  );
  const landed = (log ? log.split("\n") : [])
    .filter(subject => subject.length > 0)
    .map(landedLine)
    .slice(0, LANDED_CAP);
  const counts = await git(
    ["rev-list", "--left-right", "--count", `${defaultBranch}...HEAD`],
    sessionCwd,
  );
  const parsed = counts ? counts.split(/\s+/).map(part => Number.parseInt(part, 10)) : [0, 0];
  const behind = Number.isFinite(parsed[0]) ? parsed[0] : 0;
  const ahead = Number.isFinite(parsed[1]) ? parsed[1] : 0;
  return { defaultBranch, mainTip, landed, ahead, behind };
}

export type GhRunner = (args: string[], cwd: string) => Promise<string>;
export type PrResult = { lines: string[]; staleMs?: number } | "unavailable";

interface PrCache { fetchedAt: number; lines: string[] }

const defaultGh: GhRunner = async (args, cwd) => {
  const { stdout } = await execFileP("gh", args, {
    cwd,
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 1_000_000,
  });
  return stdout;
};

export async function openPrs(
  boardRoot: string,
  opts: { home?: string; now?: number; gh?: GhRunner } = {},
): Promise<PrResult> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const stateDir = boardStateDir(boardRoot, home);
  const cachePath = join(stateDir, "pr-cache.json");
  let cache: PrCache | null = null;
  try {
    const parsed = JSON.parse(await safeReadFile(home, cachePath, { maxBytes: 100_000 })) as PrCache;
    if (Number.isFinite(parsed.fetchedAt) && Array.isArray(parsed.lines) &&
      parsed.lines.every(line => typeof line === "string")) {
      cache = parsed;
    }
  } catch {
    // no usable cache
  }
  if (cache && now - cache.fetchedAt < PR_CACHE_FRESH_MS) return { lines: cache.lines };
  try {
    const gh = opts.gh ?? defaultGh;
    const raw = JSON.parse(await gh(
      ["pr", "list", "--json", "number,headRefName,baseRefName", "--limit", "20"],
      boardRoot,
    )) as Array<{ number?: unknown; headRefName?: unknown; baseRefName?: unknown }>;
    const lines = raw
      .filter(pr => typeof pr.number === "number" && typeof pr.headRefName === "string")
      .map(pr => `#${pr.number} ${redact(String(pr.headRefName)).slice(0, 80)} → ` +
        `${redact(String(pr.baseRefName ?? "main")).slice(0, 80)}`)
      .slice(0, 10);
    await safeMkdir(home, stateDir);
    await safeWriteFile(home, cachePath, JSON.stringify({ fetchedAt: now, lines } satisfies PrCache));
    return { lines };
  } catch {
    if (cache) return { lines: cache.lines, staleMs: now - cache.fetchedAt };
    return "unavailable";
  }
}

export interface BoardState {
  root: string;
  defaultBranch: string;
  mainTip: string;
  self?: BoardSession;
  sessions: BoardSession[];
  landed: string[];
  ahead: number;
  behind: number;
  prs: PrResult;
}

export interface AssembleOptions extends DiscoverOptions {
  selfSessionId?: string;
  gh?: GhRunner;
}

export async function assembleBoard(
  projectDir: string,
  opts: AssembleOptions = {},
): Promise<BoardState | null> {
  const root = await resolveBoardRoot(projectDir);
  if (!root) return null;
  const repo = await collectRepoState(root, projectDir);
  if (!repo) return null;
  const discovered = [
    ...(await discoverClaudeSessions(root, opts)),
    ...(await discoverCodexSessions(root, opts)),
  ].sort((a, b) => a.ageMs - b.ageMs);
  const self = discovered.find(session => session.sessionId === opts.selfSessionId);
  const sessions = discovered.filter(session => session.sessionId !== opts.selfSessionId);
  const prs = await openPrs(root, opts);
  return {
    root,
    defaultBranch: repo.defaultBranch,
    mainTip: repo.mainTip,
    ...(self ? { self } : {}),
    sessions,
    landed: repo.landed,
    ahead: repo.ahead,
    behind: repo.behind,
    prs,
  };
}

export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export function renderDigest(state: BoardState): string {
  const lines: string[] = [];
  const count = state.sessions.length;
  lines.push(`gradient board — ${count} other session${count === 1 ? "" : "s"} in this repo`);
  for (const session of state.sessions) {
    const checkout = session.worktree === "" ? "main checkout" : session.worktree;
    const status = `${session.liveness} (${formatAge(session.ageMs)})`;
    lines.push(`• ${session.agent} · ${session.branch ?? "?"} · ${checkout} · ${status}`);
    if (session.editing.length > 0) lines.push(`  editing: ${session.editing.join(", ")}`);
  }
  if (state.self) {
    const checkout = state.self.worktree === "" ? "main checkout" : state.self.worktree;
    lines.push(`(you) ${state.self.agent} · ${state.self.branch ?? "?"} · ${checkout}`);
  }
  if (state.landed.length > 0) {
    lines.push(`landed on ${state.defaultBranch} (24h): ${state.landed.join(", ")}`);
  }
  if (state.prs === "unavailable") {
    lines.push("open PRs: (PR info unavailable)");
  } else if (state.prs.lines.length > 0) {
    const label = state.prs.staleMs === undefined
      ? "open PRs"
      : `open PRs (${formatAge(state.prs.staleMs)} ago)`;
    lines.push(`${label}: ${state.prs.lines.join(", ")}`);
  }
  if (state.behind > 0) {
    lines.push(
      `heads-up: your branch is ${state.behind} commit${state.behind === 1 ? "" : "s"} ` +
      `behind ${state.defaultBranch}`,
    );
  }
  return lines.slice(0, DIGEST_LINE_CAP).join("\n");
}
