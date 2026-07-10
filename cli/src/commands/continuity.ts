import { hookInstalled, installHook, removeHook } from "../core/settings.js";

const CHECKPOINT_COMMAND = "gradient checkpoint";
const RECAP_COMMAND = "gradient recap";
const RECAP_MATCHER = "resume|compact";

export async function setContinuity(
  on: boolean,
  projectDir: string,
): Promise<{ on: boolean; settingsPath: string }> {
  if (on) {
    await installHook(projectDir, "PreCompact", CHECKPOINT_COMMAND);
    const path = await installHook(projectDir, "SessionStart", RECAP_COMMAND, { matcher: RECAP_MATCHER });
    return { on: true, settingsPath: path };
  }
  await removeHook(projectDir, "PreCompact", CHECKPOINT_COMMAND);
  const path = await removeHook(projectDir, "SessionStart", RECAP_COMMAND);
  return { on: false, settingsPath: path };
}

export async function continuityStatus(
  projectDir: string,
): Promise<{ checkpoint: boolean; recap: boolean }> {
  return {
    checkpoint: await hookInstalled(projectDir, "PreCompact", CHECKPOINT_COMMAND),
    recap: await hookInstalled(projectDir, "SessionStart", RECAP_COMMAND, { matcher: RECAP_MATCHER }),
  };
}
