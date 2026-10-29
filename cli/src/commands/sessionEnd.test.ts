import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { projectKey, saveConfig } from "../config.js";
import { shellQuote } from "../core/hookBinary.js";
import { DEBOUNCE_MS, isDue, scheduleSnippet, sessionEnd } from "./sessionEnd.js";

const execFileP = promisify(execFile);
const dirs = async (consent = true): Promise<{ project: string; home: string }> => {
  const project = await mkdtemp(join(tmpdir(), "grad-se-proj-"));
  const home = await mkdtemp(join(tmpdir(), "grad-se-home-"));
  if (consent) await saveConfig({ targets: ["claude-code"], optimizeProjects: [projectKey(project)] }, home);
  return { project, home };
};

describe("isDue", () => {
  it("waits out the debounce window", () => {
    expect(isDue(0, DEBOUNCE_MS)).toBe(true);
    expect(isDue(1_000, 1_000 + DEBOUNCE_MS - 1)).toBe(false);
    expect(isDue(1_000, 1_000 + DEBOUNCE_MS)).toBe(true);
  });
});

describe("sessionEnd", () => {
  it("runs a read-only check once per day, including concurrent callbacks", async () => {
    const { project, home } = await dirs();
    const spawns: string[][] = [];
    const spawnDetachedFn = (args: string[]) => { spawns.push(args); };
    const now = Date.parse("2026-10-28T09:00:00Z");
    await Promise.all([
      sessionEnd(project, { home, now, spawnDetachedFn }),
      sessionEnd(project, { home, now, spawnDetachedFn }),
    ]);
    expect(spawns).toEqual([["optimize"]]);
    await sessionEnd(project, { home, now: now + 60_000, spawnDetachedFn });
    await sessionEnd(project, { home, now: now + 3_600_000, spawnDetachedFn });
    expect(spawns).toHaveLength(1);
    await sessionEnd(project, { home, now: now + DEBOUNCE_MS, spawnDetachedFn });
    expect(spawns).toHaveLength(2);
  });

  it("requires current project consent and Claude support; the legacy global flag grants neither", async () => {
    const { project, home } = await dirs(false);
    let spawned = 0;
    const spawnDetachedFn = () => { spawned++; };
    await sessionEnd(project, { home, spawnDetachedFn });
    await saveConfig({ scanOnSessionStart: true }, home);
    await sessionEnd(project, { home, spawnDetachedFn });
    await saveConfig({ optimizeProjects: ["/another/project"] }, home);
    await sessionEnd(project, { home, spawnDetachedFn });
    await saveConfig({ targets: ["codex"], optimizeProjects: [projectKey(project)] }, home);
    await sessionEnd(project, { home, spawnDetachedFn });
    expect(spawned).toBe(0);
  });

  /** A detached child cannot ask which assistants to check, so it would fail
   *  every day in silence; it waits for the first interactive checkup instead. */
  it("waits until the user has chosen which assistants to check", async () => {
    const { project, home } = await dirs(false);
    let spawned = 0;
    await saveConfig({ optimizeProjects: [projectKey(project)] }, home);
    await sessionEnd(project, { home, spawnDetachedFn: () => { spawned++; } });
    expect(spawned).toBe(0);
  });

  it("fails open and stamps the attempt even if the detached child fails", async () => {
    const { project, home } = await dirs();
    const now = Date.parse("2026-10-28T09:00:00Z");
    let spawned = 0;
    await expect(sessionEnd(project, { home, now, spawnDetachedFn: () => { spawned++; throw new Error("died"); } })).resolves.toBeUndefined();
    await sessionEnd(project, { home, now: now + 60_000, spawnDetachedFn: () => { spawned++; } });
    expect(spawned).toBe(1);
  });
});

describe("scheduleSnippet", () => {
  it.skipIf(process.platform !== "darwin")("produces a launchd plist accepted by the OS parser with an executable quoted command", async () => {
    const base = await mkdtemp(join(tmpdir(), "grad-schedule-"));
    const project = join(base, "owner's project & <notes>");
    await mkdir(project);
    const runner = join(base, "fake runner.mjs");
    const result = join(base, "result.json");
    await writeFile(runner, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(result)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));`);
    const invocation = `${shellQuote(process.execPath)} ${shellQuote(runner)}`;
    const plistPath = join(base, "schedule.plist");
    await writeFile(plistPath, scheduleSnippet("darwin", project, invocation));
    const parsed = JSON.parse((await execFileP("plutil", ["-convert", "json", "-o", "-", plistPath])).stdout);
    await execFileP(parsed.ProgramArguments[0], parsed.ProgramArguments.slice(1));
    const observed = JSON.parse(await readFile(result, "utf8"));
    expect(observed).toEqual({ cwd: await realpath(project), args: ["optimize"] });
  });

  it("quotes a cron working directory and escapes cron's percent metacharacter", async () => {
    const { project } = await dirs(false);
    // A literal backslash before a percent must survive cron's unescaping too.
    const path = join(project, "owner's notes & 100% done \\% kept");
    await mkdir(path);
    const snippet = scheduleSnippet("linux", path, `${shellQuote(process.execPath)} -e 'console.log(process.cwd())' --`);
    const command = snippet.split("\n").find(line => line.startsWith("0 9 "))!.replace(/^0 9 \* \* 1 /, "");
    expect(command).toContain("\\%");
    // cron removes its percent escape before handing the command to /bin/sh.
    const output = await execFileP("/bin/sh", ["-c", command.replace(/\\%/g, "%")]);
    expect(output.stdout.trim()).toBe(await realpath(path));
    expect(snippet).not.toContain("--auto");
  });

  it("uses a native PowerShell action with explicit executable, runner, and working directory", () => {
    const snippet = scheduleSnippet("win32", "C:\\owner's repo & notes", "unused-posix-command", {
      execPath: "C:\\Program Files\\nodejs\\node.exe", scriptPath: "C:\\agent skills\\gradient.mjs",
    });
    expect(snippet).toContain("New-ScheduledTaskAction");
    expect(snippet).toContain("Register-ScheduledTask");
    const encoded = snippet.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("Set-Location -LiteralPath 'C:\\owner''s repo & notes'");
    expect(script).toContain("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\agent skills\\gradient.mjs' optimize");
    expect(script).not.toContain("unused-posix-command");
  });

  it("refuses line breaks instead of creating a second cron entry", () => {
    expect(() => scheduleSnippet("linux", "/repo\n* * * * * bad", "/usr/bin/node /runner")).toThrow(/line breaks/);
  });
});
