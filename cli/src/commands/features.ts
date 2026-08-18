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
export const FEATURES = ["continuity", "autopilot", "board", "optimize"] as const;
export type FeatureName = (typeof FEATURES)[number];

export function isFeatureName(value: string): value is FeatureName {
  return (FEATURES as readonly string[]).includes(value);
}

/**
 * What each feature does, in the words the toggle already used.
 *
 * These sentences existed only inside `setFeature`, so they were reachable
 * exactly once — at the moment you turned something on, which is after you
 * needed to know what it was. Anything that wants to *describe* a feature
 * rather than change it reads them here.
 */
export const FEATURE_PURPOSE: Record<FeatureName, string> = {
  continuity: "checkpoint before compaction, recap on resume",
  autopilot: "draft a reply when a session stalls waiting on you",
  board: "cross-session digest on start and on prompt",
  optimize: "re-check after a session ends (at most daily), surface it at the next start",
};

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
      return { on: result.on, settingsPath: result.settingsPath, detail: FEATURE_PURPOSE.continuity };
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
      return { on: result.on, settingsPath: result.settingsPath, detail: FEATURE_PURPOSE.board };
    }
    case "optimize":
      return setOptimize(on, projectDir, opts.home);
  }
}

export const SESSION_START_SUB = "session-start";
export const SESSION_END_SUB = "session-end";

async function setOptimize(
  on: boolean,
  projectDir: string,
  home?: string,
): Promise<FeatureResult> {
  const config = await loadConfig(home);
  if (on) {
    // Both halves of the loop, because one without the other is half a feature:
    // SessionEnd keeps the findings current, SessionStart is where you see them.
    const settingsPath = await installHook(projectDir, "SessionStart", gradientHookCommand(SESSION_START_SUB), {
      // The pre-0.5 form is still in some users' settings and names a flag the
      // CLI no longer parses; replace it rather than sitting beside it.
      replacing: ["gradient scan --detach", cmd => isGradientHookFor(cmd, SESSION_START_SUB)],
    });
    await installHook(projectDir, "SessionEnd", gradientHookCommand(SESSION_END_SUB), {
      replacing: [cmd => isGradientHookFor(cmd, SESSION_END_SUB)],
    });
    config.scanOnSessionStart = true;
    try {
      await saveConfig(config, home);
    } catch (error) {
      await removeHook(projectDir, "SessionStart", cmd => isGradientHookFor(cmd, SESSION_START_SUB)).catch(() => undefined);
      await removeHook(projectDir, "SessionEnd", cmd => isGradientHookFor(cmd, SESSION_END_SUB)).catch(() => undefined);
      throw error;
    }
    return {
      on: true,
      settingsPath,
      detail: FEATURE_PURPOSE.optimize,
    };
  }

  config.scanOnSessionStart = false;
  await saveConfig(config, home);
  await removeHook(projectDir, "SessionEnd", cmd => isGradientHookFor(cmd, SESSION_END_SUB));
  const settingsPath = await removeHook(projectDir, "SessionStart", cmd => isGradientHookFor(cmd, SESSION_START_SUB));
  return { on: false, settingsPath };
}
