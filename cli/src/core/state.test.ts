import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, cleanupStale, latestState, stateDir, freshState } from "./state.js";
import type { SessionState } from "./types.js";

const tmpHome = () => mkdtemp(join(tmpdir(), "grad-home-"));

describe("session state", () => {
  it("returns fresh state for a missing file", async () => {
    const home = await tmpHome();
    expect(await loadState("s1", home)).toEqual({ count: 0, attempts: 0, lastFingerprint: "", stoodDown: false, log: [] });
  });

  it("returns fresh state for a corrupt file (bounded worst case: budget restarts)", async () => {
    const home = await tmpHome();
    await mkdir(stateDir(home), { recursive: true });
    await writeFile(join(stateDir(home), "s1.json"), "{ nope");
    expect(await loadState("s1", home)).toEqual(freshState());
  });

  it("round-trips state and caps the log at 20 entries", async () => {
    const home = await tmpHome();
    const s: SessionState = {
      count: 3,
      attempts: 4,
      lastFingerprint: "tools:7",
      stoodDown: false,
      log: Array.from({ length: 25 }, (_, i) => ({ ts: `t${i}`, action: "continue" as const, why: "w", excerpt: "e" })),
    };
    await saveState("s1", s, home);
    const back = await loadState("s1", home);
    expect(back.count).toBe(3);
    expect(back.log).toHaveLength(20);
    expect(back.log[19].ts).toBe("t24"); // newest kept
  });

  it("sanitizes hostile session ids into safe filenames", async () => {
    const home = await tmpHome();
    await saveState("../../evil", freshState(), home);
    const files = await readdir(stateDir(home));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("..");
  });

  it("cleanupStale removes only files older than 7 days", async () => {
    const home = await tmpHome();
    await saveState("old", freshState(), home);
    await saveState("new", freshState(), home);
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    await utimes(join(stateDir(home), "old.json"), old, old);
    await cleanupStale(home);
    const files = await readdir(stateDir(home));
    expect(files).toEqual(["new.json"]);
  });

  it("cleanupStale swallows a missing state dir", async () => {
    const home = await tmpHome();
    await expect(cleanupStale(home)).resolves.toBeUndefined();
  });

  it("latestState returns the newest session by mtime, null when none", async () => {
    const home = await tmpHome();
    expect(await latestState(home)).toBeNull();
    await saveState("a", { ...freshState(), count: 1 }, home);
    await saveState("b", { ...freshState(), count: 2 }, home);
    const past = new Date(Date.now() - 3600 * 1000);
    await utimes(join(stateDir(home), "a.json"), past, past);
    const latest = await latestState(home);
    expect(latest?.sessionId).toBe("b");
    expect(latest?.state.count).toBe(2);
  });
});
