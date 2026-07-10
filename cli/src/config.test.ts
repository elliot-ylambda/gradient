import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHEAP_SKILL_MODEL, loadConfig, resolveCheapModel, resolveTargets, saveConfig } from "./config.js";

describe("config", () => {
  it("round-trips config under a fake home", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    expect(await loadConfig(home)).toEqual({});
    await saveConfig({ backend: "claude-cli", model: "claude-sonnet-4-6" }, home);
    expect(await loadConfig(home)).toEqual({ backend: "claude-cli", model: "claude-sonnet-4-6" });
  });
});

describe("assistant target config", () => {
  it("defaults to Claude Code and accepts/deduplicates known targets", () => {
    expect(resolveTargets({})).toEqual(["claude-code"]);
    expect(resolveTargets({ targets: ["claude-code", "codex", "codex"] })).toEqual(["claude-code", "codex"]);
  });

  it("rejects unknown, non-array, and empty targets", () => {
    expect(() => resolveTargets({ targets: ["cursor"] as never })).toThrow(/unknown target/);
    expect(() => resolveTargets({ targets: "codex" as never })).toThrow(/array/);
    expect(() => resolveTargets({ targets: [] })).toThrow(/at least one/);
  });

  it("resolves the cheap model and lets an empty string disable it", () => {
    expect(resolveCheapModel({})).toBe(DEFAULT_CHEAP_SKILL_MODEL);
    expect(resolveCheapModel({ cheapSkillModel: "" })).toBeUndefined();
    expect(resolveCheapModel({ cheapSkillModel: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
  });
});
