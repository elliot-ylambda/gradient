import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEBOUNCE_MS, isDue, scheduleSnippet, sessionEnd } from "./sessionEnd.js";

const dirs = async (): Promise<{ project: string; home: string }> => ({
  project: await mkdtemp(join(tmpdir(), "grad-se-proj-")),
  home: await mkdtemp(join(tmpdir(), "grad-se-home-")),
});

describe("isDue", () => {
  it("waits out the debounce window", () => {
    expect(isDue(0, DEBOUNCE_MS)).toBe(true);
    expect(isDue(1_000, 1_000 + DEBOUNCE_MS - 1)).toBe(false);
    expect(isDue(1_000, 1_000 + DEBOUNCE_MS)).toBe(true);
  });
});

describe("sessionEnd", () => {
  it("runs once, then stays quiet for the rest of the day", async () => {
    const { project, home } = await dirs();
    const spawns: string[][] = [];
    const spawnDetachedFn = (args: string[]) => { spawns.push(args); };

    const now = Date.parse("2026-08-13T09:00:00Z");
    await sessionEnd(project, { home, now, spawnDetachedFn });
    expect(spawns).toEqual([["optimize", "--auto"]]);

    // Someone running parallel agents ends dozens of sessions a day; mining the
    // whole corpus each time would burn CPU rediscovering the same findings.
    await sessionEnd(project, { home, now: now + 60_000, spawnDetachedFn });
    await sessionEnd(project, { home, now: now + 3_600_000, spawnDetachedFn });
    expect(spawns).toHaveLength(1);

    await sessionEnd(project, { home, now: now + DEBOUNCE_MS, spawnDetachedFn });
    expect(spawns).toHaveLength(2);
  });

  it("fails open and silently when anything goes wrong", async () => {
    const { project, home } = await dirs();
    const boom = () => { throw new Error("spawn refused"); };
    await expect(sessionEnd(project, { home, spawnDetachedFn: boom })).resolves.toBeUndefined();
  });

  // Stamped before the detached child runs: this process is about to exit, so
  // waiting would either block the session or lose the stamp entirely.
  it("stamps the watermark even if the detached run never reports back", async () => {
    const { project, home } = await dirs();
    const now = Date.parse("2026-08-13T09:00:00Z");
    let spawned = 0;
    await sessionEnd(project, { home, now, spawnDetachedFn: () => { spawned++; throw new Error("died"); } });
    expect(spawned).toBe(1);
    await sessionEnd(project, { home, now: now + 60_000, spawnDetachedFn: () => { spawned++; } });
    expect(spawned).toBe(1);
  });
});

describe("scheduleSnippet", () => {
  it("prints a runnable snippet for each platform, and installs nothing", () => {
    // Absolute, as a scheduler needs it — see scheduleSnippet.
    const RUNNER = "/opt/node/bin/node /home/u/.agents/skills/gradient-optimize/bin/gradient.mjs";
    const mac = scheduleSnippet("darwin", "/repo", RUNNER);
    expect(mac).toContain("launchd");
    expect(mac).toContain(`${RUNNER} optimize --auto`);
    expect(mac).toContain("launchctl load");

    const linux = scheduleSnippet("linux", "/repo", RUNNER);
    expect(linux).toContain("crontab -e");
    expect(linux).toMatch(/^0 9 \* \* 1 /m);

    const win = scheduleSnippet("win32", "/repo", RUNNER);
    expect(win).toContain("schtasks");
  });

  it("names the directory the schedule should run in", () => {
    expect(scheduleSnippet("linux", "/repo/project")).toContain("cd /repo/project");
  });
});
