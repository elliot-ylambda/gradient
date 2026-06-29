import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.js";

describe("config", () => {
  it("round-trips config under a fake home", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    expect(await loadConfig(home)).toEqual({});
    await saveConfig({ backend: "claude-cli", model: "claude-sonnet-4-6" }, home);
    expect(await loadConfig(home)).toEqual({ backend: "claude-cli", model: "claude-sonnet-4-6" });
  });
});
