import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CollectOptions } from "./collect.js";
import { matchesSince } from "./collect.js";
import { assertNoSymlinkPath } from "./safeFs.js";

export interface CodexSessionMeta {
  cwd: string;
  sessionId: string;
  branch?: string;
  repositoryUrl?: string;
  subagent: boolean;
}

const DISCOVERY_CAP = 10_000;
const FILE_CAP = 5_000;
const TREE_DEPTH_CAP = 20;
const FILE_BYTES_CAP = 8_000_000;
const TOTAL_BYTES_CAP = 512 * 1024 * 1024;
const META_BYTES_CAP = 128 * 1024;

function isSubagentSource(source: unknown): boolean {
  if (typeof source === "string") return source.toLowerCase().includes("subagent");
  if (!source || typeof source !== "object") return false;
  const value = source as Record<string, unknown>;
  return "subagent" in value || value.type === "subagent" || value.kind === "subagent";
}

async function walk(base: string, dir: string, files: string[], depth = 0): Promise<void> {
  if (depth > TREE_DEPTH_CAP || files.length >= DISCOVERY_CAP) return;
  let directory;
  try {
    await assertNoSymlinkPath(base, dir);
    directory = await opendir(dir);
  } catch {
    return;
  }
  for await (const entry of directory) {
    if (files.length >= DISCOVERY_CAP) break;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(base, path, files, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
}

async function firstLine(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("refusing non-regular Codex session");
    const length = Math.min(metadata.size, META_BYTES_CAP);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0 && metadata.size > META_BYTES_CAP) throw new Error("Codex session metadata line exceeds cap");
    return newline >= 0 ? text.slice(0, newline) : text;
  } finally {
    await handle.close();
  }
}

/** Read only the first rollout record; Codex stores session identity there. */
export async function readCodexSessionMeta(path: string): Promise<CodexSessionMeta | null> {
  try {
    const record = JSON.parse(await firstLine(path)) as {
      type?: unknown;
      payload?: {
        cwd?: unknown;
        id?: unknown;
        session_id?: unknown;
        agent_path?: unknown;
        source?: unknown;
        git?: { branch?: unknown; repository_url?: unknown };
      };
    };
    if (record.type !== "session_meta" || !record.payload) return null;
    const payload = record.payload;
    if (typeof payload.cwd !== "string" || payload.cwd.length > 4_096 || !isAbsolute(payload.cwd) || /[\u0000-\u001f\u007f-\u009f]/.test(payload.cwd)) {
      return null;
    }
    const id = typeof payload.id === "string"
      ? payload.id
      : typeof payload.session_id === "string"
        ? payload.session_id
        : "?";
    const source = payload.source;
    const subagent = typeof payload.agent_path === "string" || isSubagentSource(source);
    return {
      cwd: payload.cwd,
      sessionId: id.slice(0, 200),
      ...(typeof payload.git?.branch === "string" ? { branch: payload.git.branch.slice(0, 500) } : {}),
      ...(typeof payload.git?.repository_url === "string"
        ? { repositoryUrl: payload.git.repository_url.slice(0, 2_000) }
        : {}),
      subagent,
    };
  } catch {
    return null;
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function isWithinProject(cwd: string, projectPath: string): boolean {
  const rel = relative(projectPath, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Collect bounded Codex rollout JSONL without loading conversation bodies. */
export async function collectCodex(opts: CollectOptions): Promise<string[]> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const projectPath = opts.projectPath ?? process.cwd();
  const canonicalProject = await canonical(projectPath);
  const sessionsRoot = join(home, ".codex", "sessions");
  const discovered: string[] = [];
  await walk(home, sessionsRoot, discovered);
  const candidates: Array<{ path: string; size: number; mtimeMs: number; meta: CodexSessionMeta }> = [];

  for (const path of discovered) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > FILE_BYTES_CAP) continue;
      if (!matchesSince(metadata.mtimeMs, opts.sinceDays, now)) continue;
      const meta = await readCodexSessionMeta(path);
      if (!meta || meta.subagent) continue;
      if (opts.scope === "project" && !isWithinProject(await canonical(meta.cwd), canonicalProject)) continue;
      candidates.push({ path, size: metadata.size, mtimeMs: metadata.mtimeMs, meta });
    } catch {
      // The session disappeared or changed type during discovery.
    }
  }

  candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.path.localeCompare(b.path));
  const kept: string[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (kept.length >= FILE_CAP || totalBytes + candidate.size > TOTAL_BYTES_CAP) break;
    kept.push(candidate.path);
    totalBytes += candidate.size;
  }
  return kept;
}
