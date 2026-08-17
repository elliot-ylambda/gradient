import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURES, isFeatureName, setFeature } from "./features.js";
import { loadConfig, projectKey } from "../config.js";
import { hookInstalled, installHook } from "../core/settings.js";
import { isGradientHookFor } from "../core/hookBinary.js";

const temp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

describe("isFeatureName", () => {
  it("accepts exactly the consentable features", () => {
    for (const name of FEATURES) expect(isFeatureName(name)).toBe(true);
    for (const name of ["scan", "apply", "telepathy", "", "__proto__"]) {
      expect(isFeatureName(name)).toBe(false);
    }
  });
});

describe("setFeature: continuity", () => {
  it("round-trips the checkpoint and recap hooks and their consent", async () => {
    const dir = await temp("grad-feat-cont-");
    const home = await temp("grad-feat-home-");

    const on = await setFeature("continuity", true, dir, { home });
    expect(on.on).toBe(true);
    expect(await hookInstalled(dir, "PreCompact", cmd => isGradientHookFor(cmd, "checkpoint"))).toBe(true);
    expect((await loadConfig(home)).continuityProjects).toContain(projectKey(dir));

    const off = await setFeature("continuity", false, dir, { home });
    expect(off.on).toBe(false);
    expect(await hookInstalled(dir, "PreCompact", cmd => isGradientHookFor(cmd, "checkpoint"))).toBe(false);
    expect((await loadConfig(home)).continuityProjects ?? []).not.toContain(projectKey(dir));
  });
});

describe("setFeature: autopilot", () => {
  it("grants only nudge, never the full authority level", async () => {
    const dir = await temp("grad-feat-auto-");
    const home = await temp("grad-feat-home-");
    const result = await setFeature("autopilot", true, dir, { home });
    expect(result.detail).toBe("nudge");
    expect(result.on).toBe(true);
    expect(Object.values((await loadConfig(home)).autopilotProjects ?? {})).toEqual(["nudge"]);
  });

  it("turns back off", async () => {
    const dir = await temp("grad-feat-auto-off-");
    const home = await temp("grad-feat-home-");
    await setFeature("autopilot", true, dir, { home });
    const off = await setFeature("autopilot", false, dir, { home });
    expect(off.on).toBe(false);
    expect(Object.values((await loadConfig(home)).autopilotProjects ?? {})).not.toContain("nudge");
  });
});

describe("setFeature: optimize", () => {
  it("round-trips the hook and the config flag together", async () => {
    const dir = await temp("grad-feat-scan-");
    const home = await temp("grad-feat-home-");

    const on = await setFeature("optimize", true, dir, { home });
    expect(on.on).toBe(true);
    expect(await hookInstalled(dir, "SessionStart", cmd => isGradientHookFor(cmd, "session-start"))).toBe(true);
    expect((await loadConfig(home)).scanOnSessionStart).toBe(true);

    const off = await setFeature("optimize", false, dir, { home });
    expect(off.on).toBe(false);
    expect(await hookInstalled(dir, "SessionStart", cmd => isGradientHookFor(cmd, "session-start"))).toBe(false);
    expect((await loadConfig(home)).scanOnSessionStart).toBe(false);
  });

  // The pre-0.5 form names a flag the CLI no longer parses, so leaving it beside
  // the new hook would run a broken command at every session start.
  it("replaces the legacy detached-scan hook rather than sitting beside it", async () => {
    const dir = await temp("grad-feat-legacy-");
    const home = await temp("grad-feat-home-");
    await installHook(dir, "SessionStart", "gradient scan --detach", {});

    await setFeature("optimize", true, dir, { home });

    const settings = JSON.parse(await readSettings(dir));
    const commands = settings.hooks.SessionStart.flatMap((entry: { hooks: { command: string }[] }) =>
      entry.hooks.map(hook => hook.command));
    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toContain("--detach");
  });
});

async function readSettings(dir: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(join(dir, ".claude", "settings.local.json"), "utf8");
}

describe("setFeature: board", () => {
  it("refuses outside a git repository rather than half-installing", async () => {
    const dir = await temp("grad-feat-board-");
    const home = await temp("grad-feat-home-");
    await writeFile(join(dir, "marker"), "");
    await expect(setFeature("board", true, dir, { home })).rejects.toThrow(/git repository/);
    expect((await loadConfig(home)).boardProjects ?? []).toEqual([]);
  });
});
