import { hookInstalled, installHook, removeHook } from "../core/settings.js";
import { homedir } from "node:os";
import { loadConfig, projectKey, saveConfig } from "../config.js";
import { safeUnlink } from "../core/safeFs.js";
import { progressPath } from "./checkpoint.js";
import { gradientHookCommand, isGradientHookFor } from "../core/hookBinary.js";

const CHECKPOINT_SUB = "checkpoint";
const RECAP_SUB = "recap";
const RECAP_MATCHER = "resume|compact";

export async function setContinuity(
  on: boolean,
  projectDir: string,
  opts: { home?: string } = {},
): Promise<{ on: boolean; settingsPath: string }> {
  const config = await loadConfig(opts.home);
  const projects = new Set(config.continuityProjects ?? []);
  const key = projectKey(projectDir);
  if (on) {
    try {
      await installHook(projectDir, "PreCompact", gradientHookCommand(CHECKPOINT_SUB),
        { replacing: [cmd => isGradientHookFor(cmd, CHECKPOINT_SUB)] });
      const path = await installHook(projectDir, "SessionStart", gradientHookCommand(RECAP_SUB),
        { matcher: RECAP_MATCHER, replacing: [cmd => isGradientHookFor(cmd, RECAP_SUB)] });
      projects.add(key);
      config.continuityProjects = [...projects].sort();
      await saveConfig(config, opts.home);
      return { on: true, settingsPath: path };
    } catch (error) {
      projects.delete(key);
      config.continuityProjects = [...projects].sort();
      await saveConfig(config, opts.home).catch(() => undefined);
      await removeHook(projectDir, "PreCompact", cmd => isGradientHookFor(cmd, CHECKPOINT_SUB)).catch(() => undefined);
      await removeHook(projectDir, "SessionStart", cmd => isGradientHookFor(cmd, RECAP_SUB)).catch(() => undefined);
      throw error;
    }
  }
  // Revoke private consent before touching repo-local hook state. A removal
  // failure therefore leaves any stale/committed hook inert.
  projects.delete(key);
  config.continuityProjects = [...projects].sort();
  await saveConfig(config, opts.home);
  const userHome = opts.home ?? homedir();
  await safeUnlink(userHome, progressPath(projectDir, userHome)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  await removeHook(projectDir, "PreCompact", cmd => isGradientHookFor(cmd, CHECKPOINT_SUB));
  const path = await removeHook(projectDir, "SessionStart", cmd => isGradientHookFor(cmd, RECAP_SUB));
  return { on: false, settingsPath: path };
}

export async function continuityStatus(
  projectDir: string,
  opts: { home?: string } = {},
): Promise<{ checkpoint: boolean; recap: boolean }> {
  const config = await loadConfig(opts.home);
  const consented = (config.continuityProjects ?? []).includes(projectKey(projectDir));
  if (!consented) return { checkpoint: false, recap: false };
  return {
    checkpoint: await hookInstalled(projectDir, "PreCompact", cmd => isGradientHookFor(cmd, CHECKPOINT_SUB)),
    recap: await hookInstalled(projectDir, "SessionStart", cmd => isGradientHookFor(cmd, RECAP_SUB), { matcher: RECAP_MATCHER }),
  };
}
