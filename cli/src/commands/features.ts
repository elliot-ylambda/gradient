import { loadConfig, saveConfig } from "../config.js";
import { gradientHookCommand, isGradientHookFor } from "../core/hookBinary.js";
import { installHook, removeHook } from "../core/settings.js";
import { setAutopilotMode } from "./autopilot.js";
import { setBoard } from "./board.js";
import { setContinuity } from "./continuity.js";

/**
 * Everything that runs in the background and therefore needs consent.
 *
 * These were four separate verbs with three different grammars — `continuity
 * on`, `autopilot nudge`, `board on`, `init --session-scan`. They ask the same
 * question, so they get one answer: `gradient on <feature>`.
 */
export const FEATURES = ["continuity", "autopilot", "board", "session-scan"] as const;
export type FeatureName = (typeof FEATURES)[number];

export function isFeatureName(value: string): value is FeatureName {
  return (FEATURES as readonly string[]).includes(value);
}

export interface FeatureResult {
  on: boolean;
  settingsPath: string;
  /** What the toggle actually did, when that is not obvious from on/off alone. */
  detail?: string;
}

export async function setFeature(
  name: FeatureName,
  on: boolean,
  projectDir: string,
  opts: { home?: string } = {},
): Promise<FeatureResult> {
  switch (name) {
    case "continuity": {
      const result = await setContinuity(on, projectDir, opts);
      return { on: result.on, settingsPath: result.settingsPath, detail: "checkpoint before compaction, recap on resume" };
    }
    case "autopilot": {
      // `nudge` is the only mode reachable by consent: `full` exists in the
      // config schema for the authority ladder but is not something a toggle
      // should be able to grant.
      const result = await setAutopilotMode(on ? "nudge" : "off", projectDir, opts);
      return { on: result.mode !== "off", settingsPath: result.settingsPath, detail: result.mode };
    }
    case "board": {
      const result = await setBoard(on, projectDir, opts);
      return { on: result.on, settingsPath: result.settingsPath, detail: "cross-session digest on start and on prompt" };
    }
    case "session-scan":
      return setSessionScan(on, projectDir, opts.home);
  }
}

export const SESSION_SCAN_SUB = "session-start";

async function setSessionScan(
  on: boolean,
  projectDir: string,
  home?: string,
): Promise<FeatureResult> {
  const config = await loadConfig(home);
  if (on) {
    const settingsPath = await installHook(projectDir, "SessionStart", gradientHookCommand(SESSION_SCAN_SUB), {
      // The pre-0.5 form is still in some users' settings and names a flag the
      // CLI no longer parses; replace it rather than sitting beside it.
      replacing: ["gradient scan --detach", cmd => isGradientHookFor(cmd, SESSION_SCAN_SUB)],
    });
    config.scanOnSessionStart = true;
    try {
      await saveConfig(config, home);
    } catch (error) {
      await removeHook(projectDir, "SessionStart", cmd => isGradientHookFor(cmd, SESSION_SCAN_SUB)).catch(() => undefined);
      throw error;
    }
    return { on: true, settingsPath, detail: "surface one suggestion at session start, then rescan" };
  }

  config.scanOnSessionStart = false;
  await saveConfig(config, home);
  const settingsPath = await removeHook(projectDir, "SessionStart", cmd => isGradientHookFor(cmd, SESSION_SCAN_SUB));
  return { on: false, settingsPath };
}
