import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, projectCacheDir, saveConfig } from "../config.js";
import { isGradientHookFor } from "../core/hookBinary.js";
import { safeUnlink } from "../core/safeFs.js";
import { removeHook } from "../core/settings.js";

/**
 * Uninstall the removed `recall` feature from a project that still has it on.
 *
 * `recall` shipped a `UserPromptSubmit` hook, so a user who enabled it has a
 * settings entry that now names a subcommand the CLI no longer implements. Left
 * alone that entry would run on every prompt, fail as an unknown command, and
 * inject the usage text into the model's context — the one hook event where a
 * stray line of stdout is read as instructions.
 *
 * So the subcommand survives its own deletion for exactly one purpose: the
 * first time the retired hook fires it removes itself, along with the consent
 * record and the derived index. Silent, best-effort, and idempotent — a hook
 * target must never fail loudly, and a user who never had it on must never see
 * anything at all.
 */
export async function retireRecall(projectDir: string, home?: string): Promise<void> {
  const userHome = home ?? homedir();
  await removeHook(projectDir, "UserPromptSubmit", cmd => isGradientHookFor(cmd, "recall"))
    .catch(() => undefined);
  try {
    // `recallProjects` is off the Config type now, so reach it as a stray key —
    // it only exists in configs written by a version that still had the feature.
    const config = await loadConfig(userHome) as Record<string, unknown>;
    if (config.recallProjects !== undefined) {
      delete config.recallProjects;
      await saveConfig(config, userHome);
    }
  } catch {
    // A config that cannot be read or written keeps its stale key; the hook is
    // already gone, which is the part that could have caused harm.
  }
  const cache = projectCacheDir(projectDir, userHome);
  for (const file of ["recall.json", "recall.adoption.jsonl"]) {
    await safeUnlink(userHome, join(cache, file)).catch(() => undefined);
  }
}
