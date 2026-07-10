import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CollectOptions } from "./collect.js";
import { matchesSince } from "./collect.js";

export interface CodexSessionMeta {
  cwd: string;
  sessionId: string;
  branch?: string;
  repositoryUrl?: string;
  subagent: boolean;
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

async function firstLine(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
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
    if (typeof payload.cwd !== "string") return null;
    const id = typeof payload.id === "string"
      ? payload.id
      : typeof payload.session_id === "string"
        ? payload.session_id
        : "?";
    const source = payload.source;
    const subagent = typeof payload.agent_path === "string" || (
      !!source && typeof source === "object" && "subagent" in (source as Record<string, unknown>)
    );
    return {
      cwd: payload.cwd,
      sessionId: id,
      ...(typeof payload.git?.branch === "string" ? { branch: payload.git.branch } : {}),
      ...(typeof payload.git?.repository_url === "string"
        ? { repositoryUrl: payload.git.repository_url }
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

/** Collect Codex rollout JSONL without loading conversation bodies. */
export async function collectCodex(opts: CollectOptions): Promise<string[]> {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const projectPath = opts.projectPath ?? process.cwd();
  const canonicalProject = await canonical(projectPath);
  const files = await walk(join(home, ".codex", "sessions"));
  const kept: string[] = [];
  for (const file of files) {
    let fileStat;
    try {
      fileStat = await stat(file);
    } catch {
      continue;
    }
    if (!matchesSince(fileStat.mtimeMs, opts.sinceDays, now)) continue;
    const meta = await readCodexSessionMeta(file);
    if (!meta || meta.subagent) continue;
    if (opts.scope === "project" && !isWithinProject(await canonical(meta.cwd), canonicalProject)) continue;
    kept.push(file);
  }
  return kept.sort();
}
