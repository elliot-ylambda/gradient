import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeHookIntoSettings, installHook, removeHookFromSettings, removeHook, hookInstalled } from "./settings.js";

describe("mergeHookIntoSettings", () => {
  it("adds a hook, preserving unrelated settings", () => {
    const out = mergeHookIntoSettings({ model: "x" }, "SessionStart", "gradient scan --detach");
    expect(out.model).toBe("x");
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe("gradient scan --detach");
  });
  it("is idempotent for the same command", () => {
    const once = mergeHookIntoSettings({}, "SessionStart", "gradient scan --detach");
    const twice = mergeHookIntoSettings(once, "SessionStart", "gradient scan --detach");
    expect(twice.hooks.SessionStart.length).toBe(1);
  });
});

describe("installHook", () => {
  it("writes the hook into project .claude/settings.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-settings-"));
    const p = await installHook(dir, "SessionStart", "gradient scan --detach");
    const written = JSON.parse(await readFile(p, "utf8"));
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe("gradient scan --detach");
  });

  it("refuses to overwrite a corrupt settings.json instead of clobbering it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-settings-corrupt-"));
    const cdir = join(dir, ".claude");
    await mkdir(cdir, { recursive: true });
    const file = join(cdir, "settings.json");
    await writeFile(file, "{ this is not valid json");
    await expect(installHook(dir, "SessionStart", "gradient scan --detach")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("{ this is not valid json"); // untouched, not clobbered
  });
});

describe("hook timeout option", () => {
  it("adds timeout to the hook entry when given", () => {
    const out = mergeHookIntoSettings({}, "Stop", "gradient respond", { timeout: 60 });
    expect(out.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "gradient respond", timeout: 60 });
  });

  it("omits timeout when not given (existing behavior unchanged)", () => {
    const out = mergeHookIntoSettings({}, "Stop", "gradient respond");
    expect(out.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "gradient respond" });
  });
});

describe("hook matcher option", () => {
  it("adds a matcher to the hook group when given", () => {
    const out = mergeHookIntoSettings({}, "SessionStart", "gradient recap", { matcher: "resume|compact" });
    expect(out.hooks.SessionStart[0]).toEqual({
      matcher: "resume|compact",
      hooks: [{ type: "command", command: "gradient recap" }],
    });
  });

  it("upgrades an existing command with the requested matcher", () => {
    const once = mergeHookIntoSettings({}, "SessionStart", "gradient recap");
    const upgraded = mergeHookIntoSettings(once, "SessionStart", "gradient recap", { matcher: "resume|compact" });
    expect(upgraded.hooks.SessionStart).toHaveLength(1);
    expect(upgraded.hooks.SessionStart[0].matcher).toBe("resume|compact");
  });
});

describe("removeHookFromSettings", () => {
  it("removes the matching hook and drops empty groups and events", () => {
    const withHook = mergeHookIntoSettings({}, "Stop", "gradient respond");
    const out = removeHookFromSettings(withHook, "Stop", "gradient respond");
    expect(out.hooks).toBeUndefined();
  });

  it("preserves unrelated hooks in the same event", () => {
    let s = mergeHookIntoSettings({}, "Stop", "gradient respond");
    s = mergeHookIntoSettings(s, "Stop", "other-tool run");
    const out = removeHookFromSettings(s, "Stop", "gradient respond");
    expect(JSON.stringify(out)).toContain("other-tool run");
    expect(JSON.stringify(out)).not.toContain("gradient respond");
  });

  it("preserves other events and non-hook settings keys", () => {
    const s = mergeHookIntoSettings({ model: "opus" }, "SessionStart", "gradient scan --detach");
    const out = removeHookFromSettings(s, "Stop", "gradient respond");
    expect(out.model).toBe("opus");
    expect(out.hooks.SessionStart).toHaveLength(1);
  });
});

describe("removeHook / hookInstalled (fs round-trip)", () => {
  it("removeHook is a no-op when settings.json does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-set-"));
    await expect(removeHook(dir, "Stop", "gradient respond")).resolves.toContain("settings.json");
  });

  it("removeHook refuses to touch a corrupt settings.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-set-"));
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{ not json");
    await expect(removeHook(dir, "Stop", "gradient respond")).rejects.toThrow(/refusing/);
  });

  it("hookInstalled reflects install → remove round-trip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-set-"));
    expect(await hookInstalled(dir, "Stop", "gradient respond")).toBe(false);
    await installHook(dir, "Stop", "gradient respond", { timeout: 60 });
    expect(await hookInstalled(dir, "Stop", "gradient respond")).toBe(true);
    await removeHook(dir, "Stop", "gradient respond");
    expect(await hookInstalled(dir, "Stop", "gradient respond")).toBe(false);
  });
});
