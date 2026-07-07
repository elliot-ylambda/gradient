import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const pluginDir = join(repoRoot, "plugin");

describe("plugin is inert on install (spec §2 #1)", () => {
  it("ships no hooks, MCP servers, agents, monitors, or default settings", () => {
    for (const banned of ["hooks", ".mcp.json", "settings.json", "agents", "monitors"]) {
      expect(existsSync(join(pluginDir, banned))).toBe(false);
    }
  });
});

describe("plugin manifest", () => {
  it("is valid and named gradient", () => {
    const m = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(m.name).toBe("gradient");
    expect(typeof m.description).toBe("string");
    expect(typeof m.version).toBe("string");
  });
});

describe("marketplace", () => {
  it("points at ./plugin", () => {
    const m = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(m.plugins?.[0]?.source).toBe("./plugin");
    expect(m.plugins?.[0]?.name).toBe("gradient");
  });
});
