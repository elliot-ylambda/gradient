import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionState } from "./types.js";
import { assertNoSymlinkPath, safeReadFile, safeUnlink, safeWriteFile } from "./safeFs.js";
import { stripUnsafeControls } from "./security.js";

const LOG_CAP = 20;
const STALE_MS = 7 * 24 * 3600 * 1000;
const STATE_FILE_MAX_BYTES = 128_000;
const STATE_DIR_MAX_ENTRIES = 10_000;

export function stateDir(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "state");
}

export function freshState(): SessionState {
  return { count: 0, attempts: 0, lastFingerprint: "", stoodDown: false, log: [] };
}

function fileFor(sessionId: string, home?: string): string {
  // session ids are UUIDs in practice; sanitize defensively so a hostile id
  // can never escape the state dir.
  const normalized = sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  const safe = normalized.length <= 100
    ? normalized
    : `${normalized.slice(0, 40)}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
  return join(stateDir(home), `${safe}.json`);
}

function validState(value: unknown): value is SessionState {
  if (!value || typeof value !== "object") return false;
  const state = value as SessionState;
  return Number.isSafeInteger(state.count) && state.count >= 0 && state.count <= 1_000_000_000 &&
    Number.isSafeInteger(state.attempts) && state.attempts >= 0 && state.attempts <= 1_000_000_000 &&
    typeof state.lastFingerprint === "string" && state.lastFingerprint.length <= 100 &&
    typeof state.stoodDown === "boolean" && Array.isArray(state.log) && state.log.length <= 100 &&
    state.log.every(entry => entry && typeof entry.ts === "string" && entry.ts.length <= 100 &&
      (entry.action === "continue" || entry.action === "stand_down") &&
      typeof entry.why === "string" && entry.why.length <= 500 &&
      typeof entry.excerpt === "string" && entry.excerpt.length <= 2_000);
}

function safeLine(value: string, cap: number): string {
  return stripUnsafeControls(value).replace(/[\r\n]+/g, " ").slice(0, cap);
}

/** Stream a bounded private state directory instead of allocating an
 * attacker-sized readdir result. */
export async function listStateFiles(home?: string): Promise<string[]> {
  const userHome = home ?? homedir();
  const dir = stateDir(userHome);
  await assertNoSymlinkPath(userHome, dir);
  const directory = await opendir(dir);
  const files: string[] = [];
  let seen = 0;
  for await (const entry of directory) {
    if (++seen > STATE_DIR_MAX_ENTRIES) throw new Error("state directory entry cap exceeded");
    if (entry.isFile() && entry.name.endsWith(".json")) files.push(entry.name);
  }
  return files;
}

export async function loadState(sessionId: string, home?: string): Promise<SessionState> {
  const userHome = home ?? homedir();
  try {
    const raw = JSON.parse(await safeReadFile(
      userHome,
      fileFor(sessionId, userHome),
      { maxBytes: STATE_FILE_MAX_BYTES },
    )) as unknown;
    return validState(raw) ? raw : freshState();
  } catch {
    return freshState(); // missing or corrupt → fresh; worst case the budget restarts, still bounded
  }
}

export async function saveState(sessionId: string, s: SessionState, home?: string): Promise<void> {
  const userHome = home ?? homedir();
  const boundedNumber = (value: number): number => Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000_000_000)
    : 0;
  const capped: SessionState = {
    count: boundedNumber(s.count),
    attempts: boundedNumber(s.attempts),
    lastFingerprint: safeLine(String(s.lastFingerprint ?? ""), 100),
    stoodDown: s.stoodDown === true,
    log: (Array.isArray(s.log) ? s.log : []).slice(-LOG_CAP).map(entry => ({
      ts: safeLine(String(entry.ts ?? ""), 100),
      action: entry.action === "continue" ? "continue" : "stand_down",
      why: safeLine(String(entry.why ?? ""), 500),
      excerpt: safeLine(String(entry.excerpt ?? ""), 2_000),
    })),
  };
  await safeWriteFile(userHome, fileFor(sessionId, userHome), JSON.stringify(capped, null, 2));
}

/** Delete state files older than 7 days. Best-effort: every error is swallowed. */
export async function cleanupStale(home?: string, now: number = Date.now()): Promise<void> {
  try {
    const dir = stateDir(home);
    for (const f of await listStateFiles(home)) {
      try {
        const st = await lstat(join(dir, f));
        if (st.isFile() && !st.isSymbolicLink() && now - st.mtimeMs > STALE_MS) {
          await safeUnlink(home ?? homedir(), join(dir, f));
        }
      } catch {
        // ignore per-file races
      }
    }
  } catch {
    // no state dir yet — nothing to clean
  }
}

/** Newest session state by mtime, for `gradient autopilot status`. */
export async function latestState(home?: string): Promise<{ sessionId: string; state: SessionState } | null> {
  try {
    const dir = stateDir(home);
    let best: { sessionId: string; mtime: number } | null = null;
    for (const f of await listStateFiles(home)) {
      const st = await lstat(join(dir, f));
      if (!st.isFile() || st.isSymbolicLink()) continue;
      if (!best || st.mtimeMs > best.mtime) best = { sessionId: f.slice(0, -5), mtime: st.mtimeMs };
    }
    if (!best) return null;
    return { sessionId: best.sessionId, state: await loadState(best.sessionId, home) };
  } catch {
    return null;
  }
}
