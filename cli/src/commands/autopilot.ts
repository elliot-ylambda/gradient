import { access } from "node:fs/promises";
import { loadConfig, saveConfig, DEFAULT_AUTOPILOT_BUDGET } from "../config.js";
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

/** Mode is user-global (config); the Stop hook is per-project (settings.json). Spec §3.1. */
export async function setAutopilotMode(
  mode: AutopilotMode,
  projectDir: string,
  opts: { home?: string } = {},
): Promise<SetModeResult> {
  const config = await loadConfig(opts.home);
  config.autopilot = mode;
  await saveConfig(config, opts.home);
  if (mode === "off") {
    const settingsPath = await removeHook(projectDir, "Stop", RESPOND_HOOK_COMMAND);
    return { mode, hookInstalled: false, settingsPath };
  }
  const settingsPath = await installHook(projectDir, "Stop", RESPOND_HOOK_COMMAND, { timeout: HOOK_TIMEOUT_S });
  return { mode, hookInstalled: true, settingsPath };
}

export interface AutopilotStatus {
  mode: AutopilotMode;
  effectiveMode: AutopilotMode;   // mode after this repo's project clamp
  budget: number;
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

  const mode = (config.autopilot ?? "off") as AutopilotMode;
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

  const latest = await latestState(opts.home);
  return {
    mode,
    effectiveMode,
    budget: config.autopilotBudget ?? DEFAULT_AUTOPILOT_BUDGET,
    playbookPath: pbPath,
    playbookExists,
    projectPlaybookPath: projectPlaybookPath(projectDir),
    projectPlaybookExists: project !== null,
    projectMalformed,
    hookInstalled: await hookInstalled(projectDir, "Stop", RESPOND_HOOK_COMMAND),
    recent: latest?.state.log.slice(-STATUS_RECENT) ?? [],
  };
}
