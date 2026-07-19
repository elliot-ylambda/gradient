import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundedAutopilotBudget,
  DEFAULT_CHEAP_SKILL_MODEL,
  loadConfig,
  MAX_AUTOPILOT_BUDGET,
  resolveCheapModel,
  resolveTargets,
  saveConfig,
} from "./config.js";

describe("config", () => {
  it("round-trips config under a fake home", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    expect(await loadConfig(home)).toEqual({});
    await saveConfig({ backend: "claude-cli", model: "claude-sonnet-4-6" }, home);
    expect(await loadConfig(home)).toEqual({ backend: "claude-cli", model: "claude-sonnet-4-6" });
    expect((await stat(join(home, ".config", "gradient", "config.json"))).mode & 0o777).toBe(0o600);
  });
  it("fails closed on malformed config instead of silently changing backends", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    await mkdir(join(home, ".config", "gradient"), { recursive: true });
    await writeFile(join(home, ".config", "gradient", "config.json"), "{broken");
    await expect(loadConfig(home)).rejects.toThrow(/unreadable gradient config/);
  });
  it("fails closed on malformed authority-bearing consent fields", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    await mkdir(join(home, ".config", "gradient"), { recursive: true });
    const path = join(home, ".config", "gradient", "config.json");
    await writeFile(path, JSON.stringify({ recallProjects: "/repo" }));
    await expect(loadConfig(home)).rejects.toThrow(/recallProjects/);
    await writeFile(path, JSON.stringify({ autopilotProjects: { relative: "nudge" } }));
    await expect(loadConfig(home)).rejects.toThrow(/autopilotProjects/);
  });
  it("rejects a non-boolean tool-event mining switch", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    await mkdir(join(home, ".config", "gradient"), { recursive: true });
    await writeFile(
      join(home, ".config", "gradient", "config.json"),
      JSON.stringify({ mineToolEvents: "false" }),
    );
    await expect(loadConfig(home)).rejects.toThrow(/mineToolEvents.*boolean/);
  });
  it("bounds malformed and excessive paid autopilot budgets", () => {
    expect(boundedAutopilotBudget(Number.POSITIVE_INFINITY)).toBe(10);
    expect(boundedAutopilotBudget(1_000_000)).toBe(MAX_AUTOPILOT_BUDGET);
    expect(boundedAutopilotBudget(0)).toBe(0);
  });
  it("round-trips boardProjects and rejects relative paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "gradient-config-"));
    await saveConfig({ boardProjects: ["/repo/a"] }, home);
    expect((await loadConfig(home)).boardProjects).toEqual(["/repo/a"]);
    await expect(saveConfig({ boardProjects: ["relative/path"] }, home))
      .rejects.toThrow(/boardProjects/);
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
