import { spawn } from "node:child_process";

export const NOTIFY_TITLE = "Claude Code";
export const NOTIFY_BODY = "Claude Code is waiting on you";

export interface NotifyDeps {
  platform?: NodeJS.Platform;
  spawnFn?: (command: string, args: string[]) => void;
}

/** Fire a static local desktop notification. This hook target never includes
 * transcript content and never surfaces notification failures. */
export async function notify(deps: NotifyDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawnFn ?? ((command, args) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => { /* missing OS notifier: fail open */ });
    child.unref();
  });

  try {
    if (platform === "darwin") {
      spawnFn("/usr/bin/osascript", [
        "-e",
        `display notification ${JSON.stringify(NOTIFY_BODY)} with title ${JSON.stringify(NOTIFY_TITLE)}`,
      ]);
    } else if (platform === "linux") {
      spawnFn("/usr/bin/notify-send", [NOTIFY_TITLE, NOTIFY_BODY]);
    }
  } catch {
    // Unknown/missing platform support must never interrupt the host assistant.
  }
}
