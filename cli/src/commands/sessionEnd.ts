import { join } from "node:path";
import { homedir } from "node:os";
import { projectCacheDir } from "../config.js";
import { safeReadFile, safeWriteFile } from "../core/safeFs.js";
import { spawnDetached } from "../core/spawn.js";
import { gradientCommand } from "../core/hookBinary.js";

/**
 * The after-every-conversation hook.
 *
 * Two constraints shape all of it. It runs when the user is finishing, so it
 * must never make closing a session slow — the real work is detached and this
 * returns immediately. And it fires every time a session ends, which for
 * someone running parallel agents is dozens of times a day, so it debounces:
 * mining a whole transcript corpus that often would burn CPU to rediscover the
 * same findings.
 *
 * Silent and fail-open throughout. A hook that reports its own failures reports
 * them into the session it was supposed to help.
 */

export const DEBOUNCE_MS = 24 * 60 * 60 * 1000;

export interface SessionEndDeps {
  home?: string;
  now?: number;
  spawnDetachedFn?: typeof spawnDetached;
}

interface Watermark {
  lastRunAt: string;
}

function watermarkPath(projectDir: string, home: string): string {
  return join(projectCacheDir(projectDir, home), "last-optimize.json");
}

async function lastRunAt(projectDir: string, home: string): Promise<number> {
  try {
    const parsed = JSON.parse(await safeReadFile(
      home, watermarkPath(projectDir, home), { maxBytes: 4_000 },
    )) as Watermark;
    const at = Date.parse(parsed.lastRunAt);
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;
  }
}

/** Whether enough time has passed to be worth mining again. */
export function isDue(last: number, now: number, debounceMs = DEBOUNCE_MS): boolean {
  return now - last >= debounceMs;
}

export async function sessionEnd(projectDir: string, deps: SessionEndDeps = {}): Promise<void> {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now();
  try {
    if (!isDue(await lastRunAt(projectDir, home), now)) return;
    // Stamp before spawning, not after: the child is detached and this process
    // is about to exit, so waiting for it would either block the session or
    // lose the stamp. A run that fails costs one skipped day, which is the
    // right way round for a hook nobody asked to watch.
    await safeWriteFile(
      home,
      watermarkPath(projectDir, home),
      `${JSON.stringify({ lastRunAt: new Date(now).toISOString() })}\n`,
      { mode: 0o600 },
    );
    (deps.spawnDetachedFn ?? spawnDetached)(["optimize", "--auto"], projectDir);
  } catch {
    // Fail open: ending a session must never depend on this.
  }
}

/**
 * A scheduling snippet for the platform, printed rather than installed.
 *
 * gradient owns no daemon and no timer. Printing the exact command keeps the
 * scheduling decision — and the removal of it — entirely with the user.
 */
export function scheduleSnippet(platform: NodeJS.Platform, cwd: string, invocation = gradientCommand()): string {
  // gradientCommand, not displayCommand: the display form shortens to `node`
  // and `~`, which a shell undoes and a scheduler does not. launchd runs jobs
  // with PATH=/usr/bin:/bin:/usr/sbin:/sbin, where a Homebrew or version-manager
  // `node` does not appear — so the readable form is the one that fails
  // silently, at 9am on a Monday, with nowhere to report it.
  const command = `cd ${cwd} && ${invocation} optimize --auto`;
  if (platform === "darwin") {
    return [
      "# launchd — save as ~/Library/LaunchAgents/md.gradient.optimize.plist,",
      "# then: launchctl load ~/Library/LaunchAgents/md.gradient.optimize.plist",
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      "  <key>Label</key><string>md.gradient.optimize</string>",
      `  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>${command}</string></array>`,
      "  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Weekday</key><integer>1</integer></dict>",
      "</dict></plist>",
    ].join("\n");
  }
  if (platform === "win32") {
    return [
      "# Task Scheduler — run in PowerShell:",
      `schtasks /create /tn "gradient optimize" /tr "cmd /c ${command}" /sc weekly /d MON /st 09:00`,
    ].join("\n");
  }
  return [
    "# cron — add with `crontab -e`:",
    `0 9 * * 1 ${command}`,
    "",
    "# or a systemd user timer, if you prefer:",
    "#   ~/.config/systemd/user/gradient-optimize.service",
    "#   ~/.config/systemd/user/gradient-optimize.timer  (OnCalendar=Mon 09:00)",
  ].join("\n");
}
