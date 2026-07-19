import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setAutopilotMode, autopilotStatus, RESPOND_HOOK_COMMAND } from "./autopilot.js";
import { loadConfig, saveConfig, projectKey } from "../config.js";
import { hookInstalled } from "../core/settings.js";
import { saveState, freshState } from "../core/state.js";
import { playbookPath } from "../core/playbook.js";

const tmp = () => mkdtemp(join(tmpdir(), "grad-ap-"));

describe("setAutopilotMode", () => {
  it("nudge: writes config and installs the Stop hook with a 60s timeout", async () => {
    const home = await tmp(), project = await tmp();
    const r = await setAutopilotMode("nudge", project, { home });
    expect(r).toMatchObject({ mode: "nudge", hookInstalled: true });
    expect((await loadConfig(home)).autopilotProjects?.[projectKey(project)]).toBe("nudge");
    expect(await hookInstalled(project, "Stop", RESPOND_HOOK_COMMAND)).toBe(true);
    const settings = JSON.parse(await (await import("node:fs/promises")).readFile(join(project, ".claude", "settings.local.json"), "utf8"));
    expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(60);
  });

  it("off: removes the hook and sets mode off", async () => {
    const home = await tmp(), project = await tmp();
    await setAutopilotMode("nudge", project, { home });
    const r = await setAutopilotMode("off", project, { home });
    expect(r.hookInstalled).toBe(false);
    expect((await loadConfig(home)).autopilotProjects?.[projectKey(project)]).toBeUndefined();
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
    expect(cfg.autopilotProjects?.[projectKey(project)]).toBe("nudge");
  });

  it("refuses full mode until arbitrary-response hardening exists", async () => {
    const home = await tmp(), project = await tmp();
    await expect(setAutopilotMode("full", project, { home })).rejects.toThrow(/disabled/);
    expect(await hookInstalled(project, "Stop", RESPOND_HOOK_COMMAND)).toBe(false);
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

describe("autopilotStatus project layer", () => {
  it("no project file → effectiveMode equals config mode; not malformed", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "grad-repo-"));
    await saveConfig({ autopilotProjects: { [projectKey(projectDir)]: "nudge" } }, home);
    const s = await autopilotStatus(projectDir, { home });
    expect(s.effectiveMode).toBe("nudge");
    expect(s.projectPlaybookExists).toBe(false);
    expect(s.projectMalformed).toBe(false);
    expect(s.effectiveBudget).toBe(s.budget);
  });

  it("project max-mode clamps the effective mode below config", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "grad-repo-"));
    await saveConfig({ autopilotProjects: { [projectKey(projectDir)]: "nudge" } }, home);
    await writeFile(join(projectDir, "gradient.md"), "---\nautopilot:\n  max-mode: nudge\n---\n");
    const s = await autopilotStatus(projectDir, { home });
    expect(s.effectiveMode).toBe("nudge");
    expect(s.projectPlaybookExists).toBe(true);
  });

  it("project budget clamps the effective budget below config", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "grad-repo-"));
    await saveConfig({ autopilotProjects: { [projectKey(projectDir)]: "nudge" }, autopilotBudget: 10 }, home);
    await writeFile(join(projectDir, "gradient.md"), "---\nautopilot:\n  budget: 3\n---\n");
    const s = await autopilotStatus(projectDir, { home });
    expect(s.budget).toBe(10);
    expect(s.effectiveBudget).toBe(3);
    expect(s.projectPlaybookExists).toBe(true);
  });

  it("malformed project file → effectiveMode off, projectMalformed true", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "grad-repo-"));
    await saveConfig({ autopilotProjects: { [projectKey(projectDir)]: "nudge" } }, home);
    await writeFile(join(projectDir, "gradient.md"), "---\nautopilot:\n  max-mode: turbo\n---\n");
    const s = await autopilotStatus(projectDir, { home });
    expect(s.effectiveMode).toBe("off");
    expect(s.projectMalformed).toBe(true);
    expect(s.projectPlaybookExists).toBe(true);
  });
});
