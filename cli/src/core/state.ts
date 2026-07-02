import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionState } from "./types.js";

const LOG_CAP = 20;
const STALE_MS = 7 * 24 * 3600 * 1000;

export function stateDir(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "state");
}

export function freshState(): SessionState {
  return { count: 0, lastFingerprint: "", stoodDown: false, log: [] };
}

function fileFor(sessionId: string, home?: string): string {
  // session ids are UUIDs in practice; sanitize defensively so a hostile id
  // can never escape the state dir.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return join(stateDir(home), `${safe}.json`);
}

export async function loadState(sessionId: string, home?: string): Promise<SessionState> {
  try {
    const raw = JSON.parse(await readFile(fileFor(sessionId, home), "utf8")) as SessionState;
    if (typeof raw?.count !== "number" || !Array.isArray(raw.log)) return freshState();
    return { ...freshState(), ...raw };
  } catch {
    return freshState(); // missing or corrupt → fresh; worst case the budget restarts, still bounded
  }
}

export async function saveState(sessionId: string, s: SessionState, home?: string): Promise<void> {
  await mkdir(stateDir(home), { recursive: true });
  const capped: SessionState = { ...s, log: s.log.slice(-LOG_CAP) };
  await writeFile(fileFor(sessionId, home), JSON.stringify(capped, null, 2));
}

/** Delete state files older than 7 days. Best-effort: every error is swallowed. */
export async function cleanupStale(home?: string, now: number = Date.now()): Promise<void> {
  try {
    const dir = stateDir(home);
    for (const f of await readdir(dir)) {
      try {
        const st = await stat(join(dir, f));
        if (now - st.mtimeMs > STALE_MS) await unlink(join(dir, f));
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
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      const st = await stat(join(dir, f));
      if (!best || st.mtimeMs > best.mtime) best = { sessionId: f.slice(0, -5), mtime: st.mtimeMs };
    }
    if (!best) return null;
    return { sessionId: best.sessionId, state: await loadState(best.sessionId, home) };
  } catch {
    return null;
  }
}
