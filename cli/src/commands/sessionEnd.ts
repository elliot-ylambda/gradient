import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, projectCacheDir, projectKey, supportsClaudeHooks } from "../config.js";
import { safeReadFile, safeWriteFile } from "../core/safeFs.js";
import { spawnDetached } from "../core/spawn.js";
import { gradientCommand, gradientRuntimePaths, shellQuote } from "../core/hookBinary.js";
import { withLock } from "../core/run.js";

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
    const config = await loadConfig(home);
    if (!supportsClaudeHooks(config) || !config.optimizeProjects?.includes(projectKey(projectDir))) return;
    // A detached child has no terminal to ask which assistants to check; wait
    // until the first interactive checkup has made that choice.
    if (!config.targets?.length) return;
    await withLock(async () => {
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
      // Hook consent schedules inspection, not automatic application.
      (deps.spawnDetachedFn ?? spawnDetached)(["optimize"], projectDir);
    }, { home, now });
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
export function scheduleSnippet(
  platform: NodeJS.Platform,
  cwd: string,
  invocation = gradientCommand(),
  windowsRuntime = gradientRuntimePaths(),
): string {
  // gradientCommand, not displayCommand: the display form shortens to `node`
  // and `~`, which a shell undoes and a scheduler does not. launchd runs jobs
  // with PATH=/usr/bin:/bin:/usr/sbin:/sbin, where a Homebrew or version-manager
  // `node` does not appear — so the readable form is the one that fails
  // silently, at 9am on a Monday, with nowhere to report it.
  if (/[\r\n\0]/.test(cwd + invocation)) throw new Error("schedule paths must not contain line breaks or NUL");
  const command = `cd ${shellQuote(cwd)} && ${invocation} optimize`;
  if (platform === "darwin") {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- Save as ~/Library/LaunchAgents/md.gradient.optimize.plist. Then run:',
      'launchctl load ~/Library/LaunchAgents/md.gradient.optimize.plist -->',
      '<plist version="1.0"><dict>',
      "  <key>Label</key><string>md.gradient.optimize</string>",
      `  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>${xmlText(command)}</string></array>`,
      "  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Weekday</key><integer>1</integer></dict>",
      "</dict></plist>",
    ].join("\n");
  }
  if (platform === "win32") {
    const script = `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath ${powerShellQuote(cwd)}; ` +
      `& ${powerShellQuote(windowsRuntime.execPath)} ${powerShellQuote(windowsRuntime.scriptPath)} optimize; exit $LASTEXITCODE`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return [
      "# Task Scheduler — run in PowerShell:",
      `$action = New-ScheduledTaskAction -Execute (Get-Process -Id $PID).Path -Argument '-NoProfile -NonInteractive -EncodedCommand ${encoded}'`,
      "$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am",
      "Register-ScheduledTask -TaskName 'gradient optimize' -Action $action -Trigger $trigger",
    ].join("\n");
  }
  return [
    "# cron — add with `crontab -e`:",
    `0 9 * * 1 ${command.replace(/%/g, "\\%")}`,
    "",
    "# or a systemd user timer, if you prefer:",
    "#   ~/.config/systemd/user/gradient-optimize.service",
    "#   ~/.config/systemd/user/gradient-optimize.timer  (OnCalendar=Mon 09:00)",
  ].join("\n");
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function powerShellQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("schedule paths must not contain line breaks or NUL");
  return `'${value.replace(/'/g, "''")}'`;
}
