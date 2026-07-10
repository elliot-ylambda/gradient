import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedAutopilotBudget, loadConfig, MAX_AUTOPILOT_BUDGET, saveConfig } from "./config.js";

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
  it("bounds malformed and excessive paid autopilot budgets", () => {
    expect(boundedAutopilotBudget(Number.POSITIVE_INFINITY)).toBe(10);
    expect(boundedAutopilotBudget(1_000_000)).toBe(MAX_AUTOPILOT_BUDGET);
    expect(boundedAutopilotBudget(0)).toBe(0);
  });
});
