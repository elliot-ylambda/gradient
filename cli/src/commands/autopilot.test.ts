import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setAutopilotMode, autopilotStatus, RESPOND_HOOK_COMMAND } from "./autopilot.js";
import { loadConfig } from "../config.js";
import { hookInstalled } from "../core/settings.js";
import { saveState, freshState } from "../core/state.js";
import { playbookPath } from "../core/playbook.js";

const tmp = () => mkdtemp(join(tmpdir(), "grad-ap-"));

describe("setAutopilotMode", () => {
  it("nudge: writes config and installs the Stop hook with a 60s timeout", async () => {
    const home = await tmp(), project = await tmp();
    const r = await setAutopilotMode("nudge", project, { home });
    expect(r).toMatchObject({ mode: "nudge", hookInstalled: true });
    expect((await loadConfig(home)).autopilot).toBe("nudge");
    expect(await hookInstalled(project, "Stop", RESPOND_HOOK_COMMAND)).toBe(true);
    const settings = JSON.parse(await (await import("node:fs/promises")).readFile(join(project, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(60);
  });

  it("off: removes the hook and sets mode off", async () => {
    const home = await tmp(), project = await tmp();
    await setAutopilotMode("full", project, { home });
    const r = await setAutopilotMode("off", project, { home });
    expect(r.hookInstalled).toBe(false);
    expect((await loadConfig(home)).autopilot).toBe("off");
    expect(await hookInstalled(project, "Stop", RESPOND_HOOK_COMMAND)).toBe(false);
  });

  it("preserves existing config keys when switching modes", async () => {
    const home = await tmp(), project = await tmp();
    await mkdir(dirname(join(home, ".config", "gradient", "config.json")), { recursive: true });
    await writeFile(join(home, ".config", "gradient", "config.json"), JSON.stringify({ backend: "claude-cli", model: "opus" }));
    await setAutopilotMode("nudge", project, { home });
    const cfg = await loadConfig(home);
    expect(cfg.backend).toBe("claude-cli");
    expect(cfg.model).toBe("opus");
    expect(cfg.autopilot).toBe("nudge");
  });
});

describe("autopilotStatus", () => {
  it("reports mode, budget default, playbook absence, hook state, empty recent", async () => {
    const home = await tmp(), project = await tmp();
    const s = await autopilotStatus(project, { home });
    expect(s).toMatchObject({ mode: "off", budget: 10, playbookExists: false, hookInstalled: false, recent: [] });
    expect(s.playbookPath).toBe(playbookPath(home));
  });

  it("reports installed hook, existing playbook, and recent log entries", async () => {
    const home = await tmp(), project = await tmp();
    await setAutopilotMode("nudge", project, { home });
    await mkdir(dirname(playbookPath(home)), { recursive: true });
    await writeFile(playbookPath(home), "pb");
    await saveState("sess1", {
      ...freshState(), count: 2,
      log: [{ ts: "t1", action: "continue", why: "open todos", excerpt: "keep going" }],
    }, home);
    const s = await autopilotStatus(project, { home });
    expect(s.mode).toBe("nudge");
    expect(s.playbookExists).toBe(true);
    expect(s.hookInstalled).toBe(true);
    expect(s.recent).toHaveLength(1);
    expect(s.recent[0].why).toBe("open todos");
  });
});
