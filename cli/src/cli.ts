import { parseArgs } from "node:util";
import { displayCommand } from "./core/hookBinary.js";
import { remove } from "./commands/remove.js";
import { checkpoint } from "./commands/checkpoint.js";
import { respond, type StopHookInput } from "./commands/respond.js";
import { FEATURES, isFeatureName, setFeature } from "./commands/features.js";
import { optimize, optimizeJson, undo, type OptimizeResult } from "./commands/optimize.js";
import { banner, c, severityChip } from "./core/ui.js";
import { boardDigest, boardRefresh } from "./commands/board.js";
import { recap } from "./commands/recap.js";
import { notify } from "./commands/notify.js";
import { buildReport } from "./commands/report.js";
import { renderReport } from "./commands/report-render.js";
import { sessionStart } from "./commands/sessionStart.js";
import { scheduleSnippet, sessionEnd } from "./commands/sessionEnd.js";
import { VERSION } from "./version.js";
import { stripUnsafeControls } from "./core/security.js";
import type { Finding } from "./core/findings.js";

/** Subcommands that exist to be invoked by settings.json, never typed. They stay
 *  dispatchable under their bare names because that is the form already written
 *  into users' settings; `gradient hook <target>` is the form to write from now
 *  on. */
const HOOK_TARGETS: ReadonlySet<string> = new Set([
  "checkpoint", "recap", "notify", "respond", "session-start", "session-end",
]);

const help = (): string => `gradient — measure how you actually work, and keep your setup current

gradient installs as a Claude Code plugin or a copied skill directory, so there
is no \`gradient\` on your PATH. Run it as:

  ${displayCommand()} <command>

which is written \`gradient\` below. Normally you do not type it at all — ask
your assistant to optimize your setup and the skill runs these for you.

Usage:
  gradient                      the report: what it cost you, what is installed,
                                what other sessions are doing, what to do next
  gradient optimize             find what recurs and what has gone stale, across
                                Claude Code and Codex, then propose the changes
    [--target claude-code|codex|both]   which assistants to optimize for
    [--apply <id>...] [--deny <id>...] [--auto] [--undo <runId>]
    [--json]                            findings for an agent, as JSON
                                        (every run also writes a local page)
    [--print-schedule]                  a scheduling snippet for this platform
    [--user] [--all] [--since 7d] [--limit N] [--max-prompts N]
  gradient remove <name>        uninstall a generated artifact
  gradient on|off <feature>     ${FEATURES.join(" | ")}
  gradient help                 show this help
`;

export function parseCliArgs(argv: string[]): {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
} {
  const command = argv[0] ?? "";
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      target: { type: "string" },
      apply: { type: "string", multiple: true },
      deny: { type: "string", multiple: true },
      auto: { type: "boolean" },
      undo: { type: "string" },
      page: { type: "boolean" },
      "print-schedule": { type: "boolean" },
      json: { type: "boolean" },
      user: { type: "boolean" },
      all: { type: "boolean" },
      since: { type: "string" },
      limit: { type: "string" },
      "max-prompts": { type: "string" },
    },
  });
  return { command, positionals, flags: values as Record<string, string | boolean | string[]> };
}

type Flag = string | boolean | string[] | undefined;

function sinceDays(flag: Flag): number | undefined {
  if (typeof flag !== "string") return undefined;
  const m = /^(\d+)d?$/.exec(flag.trim());
  return m ? Number(m[1]) : undefined;
}

function numberFlag(flag: Flag): number | undefined {
  return typeof flag === "string" ? Number(flag) : undefined;
}

/** `--apply a,b --apply c` and `--apply a --apply b` mean the same thing. */
function idList(flag: Flag): string[] {
  const raw = Array.isArray(flag) ? flag : typeof flag === "string" ? [flag] : [];
  return raw.flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean);
}

function terminalSafeLine(value: unknown): string {
  return stripUnsafeControls(String(value)).replace(/[\r\n\t]+/g, " ");
}

type LogFn = (s: string) => void;

/** Findings grouped by family, in the order the ranking already put them. */
export function renderFindings(findings: Finding[], log: LogFn): void {
  if (findings.length === 0) {
    log(`\n${c.ok("nothing to change")} ${c.dim("— your setup matches how you actually work")}`);
    return;
  }
  let family = "";
  for (const finding of findings) {
    if (finding.family !== family) {
      family = finding.family;
      log(`\n${c.bold(family)}`);
    }
    log(`  ${severityChip(finding.severity)} ${c.dim(finding.id)}  ${terminalSafeLine(finding.title)}`);
    log(`      ${c.muted(terminalSafeLine(finding.evidence))}`);
  }
  // Only ids that carry a change apply to anything. Taking the first three
  // findings regardless printed a headline command in which every id was a
  // no-op — a report-only finding has `changes: []` by design, and a deletion
  // gradient will refuse has one too. The user copies the line gradient wrote
  // and gets three skips.
  const appliable = findings.filter(finding => finding.changes.length > 0);
  const ids = appliable.slice(0, 3).map(finding => finding.id).join(",");
  if (ids) {
    log(`\n${c.dim("apply:")} ${c.violet(`${displayCommand()} optimize --apply ${ids}`)}`);
  } else {
    log(`\n${c.dim("nothing here applies automatically — each finding says what to change")}`);
  }
  log(`${c.dim("or hand the whole list to your assistant:")} ${c.violet(`${displayCommand()} optimize --json`)}`);
}

async function runOptimize(
  projectDir: string,
  flags: Record<string, Flag>,
  home: string | undefined,
  log: LogFn,
): Promise<number> {
  if (flags["print-schedule"]) {
    log(scheduleSnippet(process.platform, projectDir));
    return 0;
  }

  if (typeof flags.undo === "string") {
    const outcome = await undo(flags.undo, { home });
    for (const path of outcome.restored) log(`${c.ok("restored")} ${c.muted(terminalSafeLine(path))}`);
    for (const path of outcome.conflicted) {
      log(c.coral(`changed since the run, left alone: ${terminalSafeLine(path)}`));
    }
    if (outcome.restored.length === 0 && outcome.conflicted.length === 0) log(c.dim("nothing to restore"));
    return 0;
  }

  const quiet = !!flags.json;
  const since = sinceDays(flags.since);
  const limit = numberFlag(flags.limit);
  const maxPrompts = numberFlag(flags["max-prompts"]);
  const result = await optimize(projectDir, {
    ...(typeof flags.target === "string" ? { target: flags.target } : {}),
    user: !!flags.user,
    all: !!flags.all,
    ...(since !== undefined ? { since } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(maxPrompts !== undefined ? { maxPrompts } : {}),
    apply: idList(flags.apply),
    deny: idList(flags.deny),
    auto: !!flags.auto,
    page: !!flags.page,
    home,
  }, { log: quiet ? () => {} : message => log(c.dim(message)) });

  if (quiet) {
    log(optimizeJson(result));
    return 0;
  }

  renderFindings(result.findings, log);
  renderFeatures(result.features, log);
  if (result.pagePath) {
    log(`\n${c.dim("checkup page:")} ${c.violet(`file://${terminalSafeLine(result.pagePath)}`)}`);
  }
  for (const entry of result.applied) {
    log(`\n${c.ok("applied")} ${terminalSafeLine(entry.title)}`);
    for (const path of entry.paths) log(`  ${c.muted(terminalSafeLine(path))}`);
  }
  for (const entry of result.skipped) {
    log(c.coral(`skipped ${entry.id}: ${terminalSafeLine(entry.reason)}`));
  }
  if (result.runId) log(`\n${c.dim("undo:")} ${c.violet(`${displayCommand()} optimize --undo ${result.runId}`)}`);
  return 0;
}

/**
 * What is running in the background, and what each one that is not would do.
 *
 * `optimize` proposes changes to files and then said nothing about the four
 * switches that change how the assistant behaves — they appeared only in the
 * report, which is a different command. Someone acting on findings is exactly
 * the person deciding what to automate, so the state belongs here too, and an
 * `off` row is useless without saying what turning it on buys.
 */
function renderFeatures(features: OptimizeResult["features"], log: LogFn): void {
  if (!features || features.length === 0) return;
  log(`\n${c.bold("features")}`);
  const width = Math.max(...features.map(feature => feature.name.length));
  for (const feature of features) {
    // Only an off row needs selling; an on row is already doing its job.
    // Padding goes only where something follows, so no row ends in whitespace.
    const purpose = feature.on ? "" : `  ${c.dim(`— ${feature.purpose}`)}`;
    const state = feature.on ? c.ok("on") : c.muted("off");
    log(`  ${feature.name.padEnd(width)}  ${state}${purpose}`);
  }
  if (features.some(feature => !feature.on)) {
    log(`  ${c.dim("turn one on with")} ${c.violet(`${displayCommand()} on <feature>`)}`);
  }
}

/** Board hook targets: fail open, and keep stdout empty unless there is a
 *  digest or a delta to report. */
async function boardHook(
  action: "digest" | "refresh",
  projectDir: string,
  io: { home?: string },
  log: LogFn,
  readStdin: () => Promise<Record<string, unknown>>,
): Promise<number> {
  try {
    const input = await readStdin();
    const text = action === "digest"
      ? await boardDigest(input as { session_id?: unknown }, projectDir, { home: io.home })
      : await boardRefresh(input as { session_id?: unknown }, projectDir, { home: io.home });
    if (text) log(text);
  } catch {
    // A board failure must never block a session.
  }
  return 0;
}

export async function main(
  argv: string[],
  io: {
    log?: (s: string) => void;
    readStdin?: () => Promise<Record<string, unknown>>;
    home?: string;
    isTTY?: boolean;
  } = {},
): Promise<number> {
  const log = io.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const readStdin = io.readStdin ?? readStdinJson;

  // A bare invocation is the report — the thing gradient is for — in a pipe as
  // much as in a terminal. It is a foreground command, not a hook target, so a
  // genuine failure is reported like any other below rather than left to crash.
  if (argv.length === 0) {
    try {
      log(banner(VERSION));
      for (const line of renderReport(await buildReport(process.cwd(), {
        home: io.home,
        ...(process.env.CLAUDE_SESSION_ID ? { selfSessionId: process.env.CLAUDE_SESSION_ID } : {}),
      }))) log(line);
    } catch (e) {
      log(c.coral(`gradient: ${terminalSafeLine((e as Error).message)}`));
      return 1;
    }
    return 0;
  }

  // Handled before parseArgs, which would reject them as unknown options, and
  // before the command switch, which would call them unknown commands. Asking a
  // CLI its version or usage is a success, not a usage error — so exit 0. The
  // version prints bare (no banner, no colour) so `gradient --version` is scriptable.
  if (argv[0] === "--version" || argv[0] === "-v") {
    log(VERSION);
    return 0;
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    log(`${banner(VERSION)}\n\n${help()}`);
    return 0;
  }

  // parseArgs throws on an unrecognized flag. Catch it here: an unknown option
  // is a usage error like an unknown command, not a crash.
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (e) {
    log(c.coral(terminalSafeLine((e as Error).message.split(".")[0])));
    log(`\n${help()}`);
    return 2;
  }
  const { command, positionals, flags } = parsed;
  const projectDir = process.cwd();

  try {
    switch (command) {
      case "optimize": {
        if (!flags.json) log(banner(VERSION));
        return await runOptimize(projectDir, flags, io.home, log);
      }
      case "remove": {
        const ok = await remove(projectDir, positionals[0], { home: io.home });
        log(ok
          ? `${c.ok("removed")} ${terminalSafeLine(positionals[0])}`
          : c.coral(`no such artifact: ${terminalSafeLine(positionals[0])}`));
        return ok ? 0 : 1;
      }
      case "on":
      case "off": {
        const feature = positionals[0];
        if (!feature || !isFeatureName(feature)) {
          log(c.coral(
            feature
              ? `unknown feature: ${terminalSafeLine(feature)}`
              : `gradient ${command} needs a feature`,
          ));
          log(c.dim(`available: ${FEATURES.join(" | ")}`));
          return 2;
        }
        const result = await setFeature(feature, command === "on", projectDir, { home: io.home });
        // Path on its own line, both ways. Inline it and an absolute settings
        // path runs straight on from the feature description with nothing
        // between them; the two branches also used to disagree on punctuation,
        // so turning a feature off did not look like turning one on.
        log(
          result.on
            ? `${c.ok(`${feature} on`)}${result.detail ? c.dim(` — ${result.detail}`) : ""}`
            : c.muted(`${feature} off`),
        );
        log(`  ${c.dim(terminalSafeLine(result.settingsPath))}`);
        return 0;
      }
      // Hook targets, namespaced. Accepting this form means a settings file can
      // say plainly that these are not commands to type.
      case "hook": {
        const target = positionals[0] ?? "";
        if (target === "board-digest") return boardHook("digest", projectDir, io, log, readStdin);
        if (target === "board-refresh") return boardHook("refresh", projectDir, io, log, readStdin);
        // Silent on an unknown target: a hook that prints a usage error feeds it
        // straight into the session it was meant to help.
        if (!HOOK_TARGETS.has(target)) return 0;
        return main([target, ...argv.slice(2)], io);
      }
      case "session-end": {
        // SessionEnd hook target: silent, fail-open, and never slow. It stamps
        // a watermark and detaches; the session is already over.
        await sessionEnd(projectDir, { home: io.home });
        return 0;
      }
      case "session-start": {
        await sessionStart(projectDir, { home: io.home, write: log });
        return 0;
      }
      case "recap": {
        const text = await recap(projectDir, { home: io.home });
        if (text) log(text);
        return 0;
      }
      case "checkpoint": {
        // Hook target: keep stdout empty even on success or failure. Claude
        // should receive recap context only from the explicit recap hook.
        try {
          const input = await readStdin();
          await checkpoint(input as { transcript_path?: string }, projectDir, undefined, { home: io.home });
        } catch {
          // Fail open: compaction proceeds without a checkpoint.
        }
        return 0;
      }
      case "notify": {
        // Notification-hook target: static text only, silent and fail-open.
        try {
          await readStdin();
          await notify();
        } catch {
          // The host assistant must never observe notification failures.
        }
        return 0;
      }
      case "respond": {
        // Stop-hook target. Contract: exit 0 ALWAYS; stdout carries ONLY the
        // block JSON (exit code 2 / stderr would be injected into Claude).
        try {
          const input = await readStdin();
          const r = await respond(input as StopHookInput, { home: io.home });
          if (r.decision === "block") log(JSON.stringify({ decision: "block", reason: r.reason }));
        } catch {
          // fail-open: the stop stands
        }
        return 0;
      }
      default: {
        log(`${c.coral(`unknown command: ${terminalSafeLine(command)}`)}\n\n${banner(VERSION)}\n\n${help()}`);
        return 2;
      }
    }
  } catch (e) {
    log(c.coral(`gradient: ${terminalSafeLine((e as Error).message)}`));
    return 1;
  }
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > 1_000_000) return {};
  }
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}
