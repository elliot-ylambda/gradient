import { access } from "node:fs/promises";
import { boundedAutopilotBudget, loadConfig, saveConfig, projectKey } from "../config.js";
import { installHook, removeHook, hookInstalled } from "../core/settings.js";
import { latestState } from "../core/state.js";
import { playbookPath, projectPlaybookPath, loadProjectPlaybook, clampMode } from "../core/playbook.js";
import type { AutopilotLogEntry, AutopilotMode } from "../core/types.js";

export type { AutopilotMode }; // single source of truth: core/types.ts

export const RESPOND_HOOK_COMMAND = "gradient respond";
const HOOK_TIMEOUT_S = 60;
const STATUS_RECENT = 5;

export interface SetModeResult {
  mode: AutopilotMode;
  hookInstalled: boolean;
  settingsPath: string;
}

/** Consent is local and per-project. A committed/stale hook is inert unless the
 * canonical project path is present in the private user config. */
export async function setAutopilotMode(
  mode: AutopilotMode,
  projectDir: string,
  opts: { home?: string } = {},
): Promise<SetModeResult> {
  if (mode === "full") {
    throw new Error("autopilot full is disabled pending additional security hardening; use nudge");
  }
  const config = await loadConfig(opts.home);
  const projects = { ...(config.autopilotProjects ?? {}) };
  const key = projectKey(projectDir);
  if (mode === "off") {
    delete projects[key];
    config.autopilotProjects = projects;
    delete config.autopilot;
    // Revoke consent first: a hook-removal failure must leave the hook inert.
    await saveConfig(config, opts.home);
    const settingsPath = await removeHook(projectDir, "Stop", RESPOND_HOOK_COMMAND);
    return { mode, hookInstalled: false, settingsPath };
  }
  const settingsPath = await installHook(projectDir, "Stop", RESPOND_HOOK_COMMAND, { timeout: HOOK_TIMEOUT_S });
  projects[key] = mode;
  config.autopilotProjects = projects;
  delete config.autopilot;
  try {
    await saveConfig(config, opts.home);
  } catch (error) {
    await removeHook(projectDir, "Stop", RESPOND_HOOK_COMMAND).catch(() => undefined);
    throw error;
  }
  return { mode, hookInstalled: true, settingsPath };
}

export interface AutopilotStatus {
  mode: AutopilotMode;
  effectiveMode: AutopilotMode;   // mode after this repo's project clamp
  budget: number;
  effectiveBudget: number;        // budget after this repo's project clamp
  playbookPath: string;
  playbookExists: boolean;
  projectPlaybookPath: string;
  projectPlaybookExists: boolean;
  projectMalformed: boolean;
  hookInstalled: boolean;
  recent: AutopilotLogEntry[];
}

export async function autopilotStatus(
  projectDir: string,
  opts: { home?: string } = {},
): Promise<AutopilotStatus> {
  const config = await loadConfig(opts.home);
  const pbPath = playbookPath(opts.home);
  let playbookExists = true;
  try {
    await access(pbPath);
  } catch {
    playbookExists = false;
  }

  const mode = (config.autopilotProjects?.[projectKey(projectDir)] ?? "off") as AutopilotMode;
  const project = await loadProjectPlaybook(projectDir);
  let effectiveMode = mode;
  let projectMalformed = false;
  if (project) {
    if (project.clamps.malformed) {
      effectiveMode = "off";
      projectMalformed = true;
    } else if (project.clamps.maxMode) {
      effectiveMode = clampMode(effectiveMode, project.clamps.maxMode);
    }
  }

  const budget = boundedAutopilotBudget(config.autopilotBudget);
  let effectiveBudget = budget;
  if (project && !project.clamps.malformed && project.clamps.budget !== undefined) {
    effectiveBudget = Math.min(budget, project.clamps.budget);
  }

  const latest = await latestState(opts.home);
  return {
    mode,
    effectiveMode,
    budget,
    effectiveBudget,
    playbookPath: pbPath,
    playbookExists,
    projectPlaybookPath: projectPlaybookPath(projectDir),
    projectPlaybookExists: project !== null,
    projectMalformed,
    hookInstalled: await hookInstalled(projectDir, "Stop", RESPOND_HOOK_COMMAND),
    recent: latest?.state.log.slice(-STATUS_RECENT) ?? [],
  };
}
