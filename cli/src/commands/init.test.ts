import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";
import { saveConfig } from "../config.js";

const fakeSkill = (body: string) => `---\nname: gradient\ndescription: test skill\n---\n\n# ${body}\n`;

describe("init", () => {
  it("writes config and installs the skill under a fake home", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const r = await init(
      { installSkill: true, home },
      { backend: { name: "claude-cli", available: async () => true, complete: async () => "" }, skillSource: fakeSkill("fake skill") },
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
    expect(r.skillPaths).toEqual([]);
  });

  it("installs the portable skill for Codex and persists the target", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const result = await init(
      { installSkill: true, home, targets: ["codex"] },
      { backend: { name: "codex-cli", available: async () => true, complete: async () => "" }, skillSource: fakeSkill("portable") },
    );
    expect(result.skillPaths).toEqual([join(home, ".agents", "skills", "gradient", "SKILL.md")]);
    expect(await readFile(result.skillPaths[0], "utf8")).toContain("portable");
    const config = JSON.parse(await readFile(join(home, ".config", "gradient", "config.json"), "utf8"));
    expect(config).toMatchObject({ backend: "codex-cli", targets: ["codex"] });
  });

  it("installs both copies for the both-assistant target", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const result = await init(
      { installSkill: true, home, targets: ["claude-code", "codex"] },
      { backend: null, skillSource: fakeSkill("portable") },
    );
    expect(result.skillPaths).toEqual([
      join(home, ".claude", "skills", "gradient", "SKILL.md"),
      join(home, ".agents", "skills", "gradient", "SKILL.md"),
    ]);
  });

  it("refuses a symlinked global .agents root without writing outside home", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const outside = await mkdtemp(join(tmpdir(), "grad-init-victim-"));
    await symlink(outside, join(home, ".agents"));
    await expect(init(
      { installSkill: true, home, targets: ["codex"] },
      { backend: null, skillSource: fakeSkill("portable") },
    )).rejects.toThrow(/symlink/);
    await expect(readFile(join(outside, "skills", "gradient", "SKILL.md"), "utf8")).rejects.toThrow();
  });

  it("refuses to replace an unowned global skill", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const path = join(home, ".agents", "skills", "gradient", "SKILL.md");
    await mkdir(join(home, ".agents", "skills", "gradient"), { recursive: true });
    await writeFile(path, "hand-written\n");
    await expect(init(
      { installSkill: true, home, targets: ["codex"] },
      { backend: null, skillSource: fakeSkill("portable") },
    )).rejects.toThrow(/unowned/);
    expect(await readFile(path, "utf8")).toBe("hand-written\n");
  });

  it("rejects Claude-only session hooks for a Codex-only target", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    await expect(init(
      { installSkill: false, sessionScan: true, home, targets: ["codex"] },
      { backend: null },
    )).rejects.toThrow(/requires the claude-code target/);
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
