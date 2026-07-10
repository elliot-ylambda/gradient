import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";
import { saveConfig } from "../config.js";

describe("init", () => {
  it("writes config and installs the skill under a fake home", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const r = await init(
      { installSkill: true, home },
      { backend: { name: "claude-cli", available: async () => true, complete: async () => "" }, skillSource: "# fake skill\n" },
    );
    expect(r.backend).toBe("claude-cli");
    expect(r.skillInstalled).toBe(true);
    const cfg = JSON.parse(await readFile(join(home, ".config/gradient/config.json"), "utf8"));
    expect(cfg.backend).toBe("claude-cli");
    const skill = await readFile(join(home, ".claude/skills/gradient/SKILL.md"), "utf8");
    expect(skill).toContain("fake skill");
  });
  it("reports no backend without throwing", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const r = await init({ installSkill: false, home }, { backend: null, skillSource: "x" });
    expect(r.backend).toBe("none");
    expect(r.skillInstalled).toBe(false);
  });
  it("installs a SessionStart scan hook and sets the config flag when sessionScan is on", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-init-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "grad-init-proj-"));
    const r = await init(
      { installSkill: false, sessionScan: true, home, projectDir },
      { backend: null },
    );
    expect(r.sessionScanInstalled).toBe(true);
    const cfg = JSON.parse(await readFile(join(home, ".config", "gradient", "config.json"), "utf8"));
    expect(cfg.scanOnSessionStart).toBe(true);
    const settings = JSON.parse(await readFile(join(projectDir, ".claude", "settings.local.json"), "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("gradient scan --detach");
  });
  it("preserves existing config keys instead of clobbering them (init doesn't disable autopilot)", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    await saveConfig({ autopilot: "nudge", model: "opus" }, home);
    const r = await init(
      { installSkill: false, home },
      { backend: { name: "claude-cli", available: async () => true, complete: async () => "" } },
    );
    expect(r.backend).toBe("claude-cli");
    const cfg = JSON.parse(await readFile(join(home, ".config/gradient/config.json"), "utf8"));
    expect(cfg.autopilot).toBe("nudge");
    expect(cfg.model).toBe("opus");
    expect(cfg.backend).toBe("claude-cli");
  });
});
