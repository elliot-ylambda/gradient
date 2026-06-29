import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";

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
});
