import { hookInstalled, installHook, removeHook } from "../core/settings.js";
import { homedir } from "node:os";
import { loadConfig, projectKey, saveConfig } from "../config.js";
import { safeUnlink } from "../core/safeFs.js";
import { progressPath } from "./checkpoint.js";

const CHECKPOINT_COMMAND = "gradient checkpoint";
const RECAP_COMMAND = "gradient recap";
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
      await installHook(projectDir, "PreCompact", CHECKPOINT_COMMAND);
      const path = await installHook(projectDir, "SessionStart", RECAP_COMMAND, { matcher: RECAP_MATCHER });
      projects.add(key);
      config.continuityProjects = [...projects].sort();
      await saveConfig(config, opts.home);
      return { on: true, settingsPath: path };
    } catch (error) {
      projects.delete(key);
      config.continuityProjects = [...projects].sort();
      await saveConfig(config, opts.home).catch(() => undefined);
      await removeHook(projectDir, "PreCompact", CHECKPOINT_COMMAND).catch(() => undefined);
      await removeHook(projectDir, "SessionStart", RECAP_COMMAND).catch(() => undefined);
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
  await removeHook(projectDir, "PreCompact", CHECKPOINT_COMMAND);
  const path = await removeHook(projectDir, "SessionStart", RECAP_COMMAND);
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
    checkpoint: await hookInstalled(projectDir, "PreCompact", CHECKPOINT_COMMAND),
    recap: await hookInstalled(projectDir, "SessionStart", RECAP_COMMAND, { matcher: RECAP_MATCHER }),
  };
}
