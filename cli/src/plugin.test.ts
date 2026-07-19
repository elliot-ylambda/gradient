import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { VERSION } from "./version.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginDir = join(repoRoot, "plugin");

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
    // Nothing but metadata — no inline hooks/mcpServers/agents/settings sneaking in.
    expect(Object.keys(m).sort()).toEqual(["author", "description", "homepage", "name", "version"]);
  });
});

describe("marketplace", () => {
  it("points at ./plugin", () => {
    const m = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(m.plugins?.[0]?.source).toBe("./plugin");
    expect(m.plugins?.[0]?.name).toBe("gradient");
  });
});

describe("plugin bundle", () => {
  it("version in plugin.json matches cli/package.json (stale bundle guard)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "cli", "package.json"), "utf8"));
    const m = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(m.version).toBe(pkg.version);
  });
  it("bundled bin runs offline and prints the banner", () => {
    const bin = join(pluginDir, "bin", "gradient.mjs");
    expect(existsSync(bin)).toBe(true);
    const r = spawnSync(process.execPath, [bin], { encoding: "utf8", timeout: 15000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(VERSION);   // banner includes the version
    expect(r.stdout).toContain("gradient scan");  // HELP text
  });
});

function frontmatter(skill: string): Record<string, string> {
  const raw = readFileSync(join(pluginDir, "skills", skill, "SKILL.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  expect(m).not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of m![1].split("\n")) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

describe("plugin skills", () => {
  it("ships exactly scan, review, stats, autopilot", () => {
    expect(readdirSync(join(pluginDir, "skills")).sort()).toEqual(["autopilot", "review", "scan", "stats"]);
  });
  it("every skill has a description and invokes the bundled bin", () => {
    for (const s of ["scan", "review", "stats", "autopilot"]) {
      expect(frontmatter(s).description).toBeTruthy();
      const body = readFileSync(join(pluginDir, "skills", s, "SKILL.md"), "utf8");
      expect(body).toContain('node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs"');
      expect(body).not.toMatch(/(^|[^/])\bgradient (scan|review|apply|stats|autopilot|remove|list|explain|init)/); // no PATH fallback
    }
  });
  it("only autopilot is user-invocation-only", () => {
    expect(frontmatter("autopilot")["disable-model-invocation"]).toBe("true");
    for (const s of ["scan", "review", "stats"]) {
      expect(frontmatter(s)["disable-model-invocation"]).toBeUndefined();
    }
  });
});
