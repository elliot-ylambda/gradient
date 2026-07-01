import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeHookIntoSettings, installHook } from "./settings.js";

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
});
