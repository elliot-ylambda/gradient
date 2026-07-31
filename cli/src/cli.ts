import { parseArgs } from "node:util";
import { basename, relative } from "node:path";
import { scan } from "./commands/scan.js";
import { review, readlineClarifier, readlinePlaybookPrompter, readlinePrompter, reviewJson } from "./commands/review.js";
import * as reviewCommands from "./commands/review.js";
import { applyByIds } from "./commands/apply.js";
import { remove } from "./commands/remove.js";
import { init } from "./commands/init.js";
import { checkpoint } from "./commands/checkpoint.js";
import { respond, type StopHookInput } from "./commands/respond.js";
import { autopilotStatus } from "./commands/autopilot.js";
import { FEATURES, isFeatureName, setFeature } from "./commands/features.js";
import { retireRecall } from "./commands/retire.js";
import { banner, c, confidenceChip } from "./core/ui.js";
import { isMeasured } from "./core/classify.js";
import { spawnDetached } from "./core/spawn.js";
import { resolveScanScope } from "./core/scope.js";
import { isNudge } from "./core/playbook.js";
import { loadConfig, resolveCheapModel, resolveTargets } from "./config.js";
import { VERSION } from "./version.js";
import { insights, writeInsightsHtml, type InsightsReport } from "./commands/insights.js";
import { buildReport } from "./commands/report.js";
import { renderReport } from "./commands/report-render.js";
import { boardDigest, boardRefresh } from "./commands/board.js";
import { recap } from "./commands/recap.js";
import { bundleCommand } from "./commands/bundle.js";
import { notify } from "./commands/notify.js";
import type { Assistant, Suggestion } from "./core/types.js";
import { stripUnsafeControls } from "./core/security.js";
import { readlineConfirm, type Confirm } from "./core/confirm.js";
import { sessionStart } from "./commands/sessionStart.js";

/** Subcommands that exist to be invoked by settings.json, never typed. They stay
 *  dispatchable under their bare names because that is the form already written
 *  into users' settings; `gradient hook <target>` is the form to write from now
 *  on. `recall` is retired and only removes itself. */
const HOOK_TARGETS: ReadonlySet<string> = new Set([
  "checkpoint", "recap", "notify", "respond", "session-start", "recall",
]);

const HELP = `gradient — measure how you actually work, and automate what recurs

Usage:
  gradient                      the report: what it cost you, what is installed,
                                what other sessions are doing, what to do next
  gradient scan                 find recurring patterns, then walk the proposals
    [--user] [--all] [--since 7d] [--limit N] [--max-prompts N] [--no-review] [--json]
  gradient apply <id|name>...   install specific proposals
  gradient remove <name>        uninstall a generated artifact
  gradient on|off <feature>     continuity | autopilot | board | session-scan
  gradient init [--target claude-code|codex|both]
                                first-run setup: config plus the bundled skill
  gradient help                 show this help
`;

export function parseCliArgs(argv: string[]): {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const command = argv[0] ?? "";
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      user: { type: "boolean" },
      all: { type: "boolean" },
      since: { type: "string" },
      limit: { type: "string" },
      "max-prompts": { type: "string" },
      "no-skill": { type: "boolean" },
      "session-scan": { type: "boolean" },
      "no-review": { type: "boolean" },
      "no-scan": { type: "boolean" },
      detach: { type: "boolean" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      html: { type: "boolean" },
      verbose: { type: "boolean" },
      "with-hooks": { type: "boolean" },
      target: { type: "string" },
    },
  });
  return { command, positionals, flags: values as Record<string, string | boolean> };
}

function sinceDays(flag: string | boolean | undefined): number | undefined {
  if (typeof flag !== "string") return undefined;
  const m = /^(\d+)d?$/.exec(flag.trim());
  return m ? Number(m[1]) : undefined;
}

/** Quote one argument for POSIX shells. JSON/double-quote escaping is not shell
 * escaping: command substitutions remain active inside double quotes. */
export function posixShellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function terminalSafePath(value: string): string | undefined {
  return /[\u0000-\u001f\u007f-\u009f]/.test(value) ? undefined : value;
}

function terminalSafeLine(value: unknown): string {
  return stripUnsafeControls(String(value)).replace(/[\r\n\t]+/g, " ");
}

function initTargets(flag: string | boolean | undefined): Assistant[] | undefined {
  if (flag === undefined) return undefined;
  if (flag === "claude-code") return ["claude-code"];
  if (flag === "codex") return ["codex"];
  if (flag === "both") return ["claude-code", "codex"];
  throw new Error(`unknown init target: ${String(flag)} (use claude-code|codex|both)`);
}

type LogFn = (s: string) => void;

async function runReview(
  projectDir: string,
  home: string | undefined,
  log: LogFn,
  confirm: Confirm,
): Promise<void> {
  const config = await loadConfig(home);
  const playbookPrompter = Object.prototype.hasOwnProperty.call(reviewCommands, "readlinePlaybookPrompter")
    ? readlinePlaybookPrompter()
    : undefined;
  const applied = await review(projectDir, readlinePrompter({
    targets: resolveTargets(config),
    cheapModel: resolveCheapModel(config),
  }), { home, onSkip: log, onExplain: log, clarifier: readlineClarifier(), playbookPrompter });
  log(`\n${c.ok(`applied ${applied.length} suggestion(s).`)}`);
  for (const a of applied) {
    for (const write of a.writes) {
      log(`${c.ok("wrote")} ${c.muted(terminalSafeLine(write.path))}${write.target === "codex" ? c.dim(" [codex]") : ""}`);
    }
    if (a.printed) log(`  ${c.dim("run:")} ${a.printed}`);
    for (const failure of a.failures) log(c.coral(`  ${failure.target}: ${terminalSafeLine(failure.error)}`));
    for (const target of a.skippedTargets) log(c.muted(`  skipped ${target}: artifact type is not portable`));
  }
}

async function runScanFlow(
  opts: {
    user: boolean;
    all: boolean;
    since?: number;
    limit?: number;
    maxPrompts?: number;
    noReview: boolean;
  },
  projectDir: string,
  home: string | undefined,
  log: LogFn,
  confirm: Confirm,
): Promise<void> {
  const config = await loadConfig(home);
  const resolved = resolveScanScope(
    { user: opts.user, all: opts.all, since: opts.since },
    config,
  );
  log(c.dim(resolved.label));
  const out = await scan(
    {
      scope: resolved.scope,
      projectPath: projectDir,
      sinceDays: resolved.sinceDays,
      limit: opts.limit,
      maxPrompts: opts.maxPrompts,
      home,
    },
    { log, config },
  );
  // Two tiers, measured first. Suggestions built from counted tool events
  // (compactions, idle waits, failure loops) are direct measurements; those
  // built from prompt text are interpretations of what repeated phrasing meant.
  // Dogfooding found every good suggestion in the first group and most of the
  // noise in the second, so the split is the ranking that matters.
  const measured = out.filter(isMeasured);
  const possible = out.filter(s => !isMeasured(s));
  const renderSuggestion = (s: Suggestion): void => {
    // estMinutesSavedPerMonth is derived from the occurrence count, so any
    // count inflation lands straight in it. Kept in the cache, never shown.
    log(
      `  ${confidenceChip(s.confidence)} ${c.bold(terminalSafeLine(s.name))}  ${c.muted(terminalSafeLine(s.title))}  ${c.dim(`(seen ${s.evidence.count}× · ${s.evidence.sessions} session(s))`)}`,
    );
    if (isNudge(s)) {
      log(`      ${c.dim("tip: this is what autopilot automates →")} ${c.violet("gradient on autopilot")}`);
    }
  };
  if (measured.length > 0) {
    log(`\n${c.bold("measured")} ${c.dim("— counted from tool events")}`);
    for (const s of measured) renderSuggestion(s);
  }
  if (possible.length > 0) {
    log(`\n${c.bold("possible")} ${c.dim("— inferred from repeated prompts; check the evidence before installing")}`);
    for (const s of possible) renderSuggestion(s);
  }
  if (out.length === 0) {
    log(`\n${c.dim("no suggestions found — try a wider scan:")} ${c.violet("gradient scan --user")}`);
    return;
  }
  if (!opts.noReview && await confirm(`\nReview these ${out.length} suggestion(s) now?`, true)) {
    await runReview(projectDir, home, log, confirm);
    return;
  }
  log(`\n${c.dim("Next:")} ${c.violet("gradient scan")}`);
}


/** `autopilot status` kept as an alias: mode, budget, clamps, and recent
 *  decisions are too specific to fold into the report's one-line feature row. */
async function autopilotStatusReport(
  projectDir: string,
  io: { home?: string },
  log: LogFn,
): Promise<number> {
  const s = await autopilotStatus(projectDir, { home: io.home });
  log(banner(VERSION));
  log(`${c.muted("mode:")} ${c.bold(s.mode)}${s.effectiveMode !== s.mode ? c.dim(` → ${s.effectiveMode} here (clamped by project gradient.md)`) : ""}`);
  log(`${c.muted("budget:")} ${s.budget} judge attempts/session${s.effectiveBudget !== s.budget ? c.dim(` → ${s.effectiveBudget} here (clamped by project gradient.md)`) : ""}`);
  log(`${c.muted("gradient.md:")} ${s.playbookPath}${s.playbookExists ? "" : c.dim(" (not yet generated — approve a suggestion first)")}`);
  log(
    `${c.muted("project gradient.md:")} ${s.projectPlaybookExists
      ? s.projectPlaybookPath + (s.projectMalformed ? c.coral(" (malformed — autopilot off here)") : "")
      : c.dim("none in this repo")}`,
  );
  log(`${c.muted("project gradient.md pin:")} ${s.projectPlaybookExists ? s.projectPlaybookPin : "none"}`);
  log(`${c.muted("stop hook here:")} ${s.hookInstalled ? c.ok("installed") : "not installed"}`);
  for (const e of s.recent) {
    log(`  ${c.dim(e.ts)} ${e.action === "continue" ? c.ok("continued") : c.muted("stood down")}  ${c.dim(e.why)}`);
  }
  return 0;
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

/** The bare report minus everything that needs project scope. `--user` asks the
 *  same questions across projects, where installed artifacts and other sessions
 *  in this repository are not the answer. */
function renderInsightsOnly(report: InsightsReport): string[] {
  return renderReport({
    insights: report,
    adoption: [],
    pending: [],
    features: [],
    board: null,
  });
}

export async function main(
  argv: string[],
  io: {
    log?: (s: string) => void;
    readStdin?: () => Promise<Record<string, unknown>>;
    home?: string;
    confirm?: Confirm;
    isTTY?: boolean;
  } = {},
): Promise<number> {
  const log = io.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const readStdin = io.readStdin ?? readStdinJson;
  const confirm = io.confirm ?? readlineConfirm();

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
  if (argv[0] === "--help" || argv[0] === "-h") {
    log(`${banner(VERSION)}\n\n${HELP}`);
    return 0;
  }
  if (argv[0] === "help") {
    log(`${banner(VERSION)}\n\n${HELP}`);
    return 0;
  }

  // parseArgs throws on an unrecognized flag. Catch it here: an unknown option
  // is a usage error like an unknown command, not a crash.
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (e) {
    log(c.coral(terminalSafeLine((e as Error).message.split(".")[0])));
    log(`\n${HELP}`);
    return 2;
  }
  const { command, positionals, flags } = parsed;
  const projectDir = process.cwd();

  try {
    switch (command) {
      case "init": {
        const r = await init({
          installSkill: !flags["no-skill"],
          sessionScan: !!flags["session-scan"],
          home: io.home,
          projectDir,
          targets: initTargets(flags.target),
        });
        log(banner(VERSION));
        log(
          `${c.muted("backend:")} ${terminalSafeLine(r.backend)}\n${c.muted("config:")} ${terminalSafeLine(r.configPath)}\n${c.muted("skill installed:")} ${r.skillPaths.length ? r.skillPaths.map(terminalSafeLine).join(", ") : "false"}\n${c.muted("session-start scan:")} ${r.sessionScanInstalled}`,
        );
        // Setup is only useful once a first scan has run — flow straight into
        // the funnel instead of leaving the next command to be remembered.
        if (!flags["no-scan"] && await confirm("\nScan your history for suggestions now?", true)) {
          await runScanFlow(
            { user: false, all: false, noReview: false },
            projectDir, io.home, log, confirm,
          );
        }
        return 0;
      }
      case "scan": {
        if (flags.detach) {
          const passthrough = argv.slice(1).filter(a => a !== "--detach");
          spawnDetached(["scan", ...passthrough], projectDir);
          return 0;
        }
        // Agents want the proposals, not the walkthrough. Scan quietly, then
        // emit the same JSON the review path emits.
        if (flags.json) {
          await runScanFlow(
            {
              user: !!flags.user,
              all: !!flags.all,
              since: sinceDays(flags.since),
              limit: flags.limit ? Number(flags.limit) : undefined,
              maxPrompts: flags["max-prompts"] ? Number(flags["max-prompts"]) : undefined,
              noReview: true,
            },
            projectDir, io.home, () => {}, confirm,
          );
          log(await reviewJson(projectDir, io.home));
          return 0;
        }
        log(banner(VERSION));
        await runScanFlow(
          {
            user: !!flags.user,
            all: !!flags.all,
            since: sinceDays(flags.since),
            limit: flags.limit ? Number(flags.limit) : undefined,
            maxPrompts: flags["max-prompts"] ? Number(flags["max-prompts"]) : undefined,
            noReview: !!flags["no-review"],
          },
          projectDir, io.home, log, confirm,
        );
        return 0;
      }
      case "session-start": {
        await sessionStart(projectDir, {
          home: io.home,
          write: log,
          spawnDetachedFn: spawnDetached,
        });
        return 0;
      }
      case "review": {
        if (flags.json) {
          log(await reviewJson(projectDir, io.home));
          return 0;
        }
        await runReview(projectDir, io.home, log, confirm);
        return 0;
      }
      case "apply": {
        const applied = await applyByIds(positionals, projectDir, {
          home: io.home,
          onSkip: log,
          onNote: message => log(c.coral(terminalSafeLine(message))),
        });
        for (const a of applied) {
          for (const write of a.writes) {
            log(`${c.ok("wrote")} ${c.muted(terminalSafeLine(write.path))}${write.target === "codex" ? c.dim(" [codex]") : ""}`);
          }
          if (a.printed) log(`${c.dim("run:")} ${a.printed}`);
          for (const failure of a.failures) log(c.coral(`${failure.target}: ${terminalSafeLine(failure.error)}`));
          for (const target of a.skippedTargets) log(c.muted(`skipped ${target}: artifact type is not portable`));
        }
        return 0;
      }
      case "remove": {
        const ok = await remove(projectDir, positionals[0], { home: io.home });
        log(ok ? `${c.ok("removed")} ${terminalSafeLine(positionals[0])}` : c.coral(`no such artifact: ${terminalSafeLine(positionals[0])}`));
        return ok ? 0 : 1;
      }
      // Retired. The subcommand outlives the feature only so an installed
      // UserPromptSubmit hook can remove itself the first time it fires; stdout
      // stays empty because this event's output is read as model context.
      case "recall": {
        await retireRecall(projectDir, io.home).catch(() => undefined);
        return 0;
      }
      // Aliases for the bare report. Kept for one release so a settings entry,
      // a script, or muscle memory still works; the report is the answer to all
      // four of these questions and printing it beats explaining the change.
      case "insights":
      case "stats":
      case "mirror":
      case "list": {
        log(banner(VERSION));
        if (command !== "insights") {
          log(c.dim(`gradient ${command} is now just gradient`));
        }
        // --user is a scope, not a different report: it answers the same
        // questions across projects, so it keeps the narrower insights view.
        if (flags.user || flags.html) {
          const report = await insights({ projectDir, user: !!flags.user, home: io.home });
          for (const line of renderInsightsOnly(report)) log(line);
          if (flags.html) log(`${c.ok("wrote")} ${c.muted(await writeInsightsHtml(projectDir, report))}`);
          return 0;
        }
        for (const line of renderReport(await buildReport(projectDir, { home: io.home }))) log(line);
        return 0;
      }
      // Hook targets, namespaced. Nothing writes this form into settings yet —
      // the bare subcommands below stay the installed form until a release has
      // passed — but accepting it now means a settings file can say plainly
      // that these are not commands to type.
      case "hook": {
        const target = positionals[0] ?? "";
        if (target === "board-digest") return boardHook("digest", projectDir, io, log, readStdin);
        if (target === "board-refresh") return boardHook("refresh", projectDir, io, log, readStdin);
        // Silent on an unknown target: a hook that prints a usage error feeds it
        // straight into the session it was meant to help.
        if (!HOOK_TARGETS.has(target)) return 0;
        return main([target, ...argv.slice(2)], io);
      }
      case "recap": {
        const text = await recap(projectDir, { home: io.home });
        if (text) log(text);
        return 0;
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
        log(
          result.on
            ? `${c.ok(`${feature} on`)}${result.detail ? c.dim(` — ${result.detail}`) : ""} ${c.muted(terminalSafeLine(result.settingsPath))}`
            : `${c.muted(`${feature} off:`)} ${terminalSafeLine(result.settingsPath)}`,
        );
        return 0;
      }
      // Aliases for the single consent verb.
      case "continuity":
      case "autopilot":
      case "board": {
        const action = positionals[0];
        if (action === "on" || action === "off" || action === "nudge") {
          log(c.dim(`gradient ${command} ${action} is now gradient ${action === "off" ? "off" : "on"} ${command}`));
          return main([action === "off" ? "off" : "on", command], io);
        }
        if (command === "board" && (action === "digest" || action === "refresh")) {
          return boardHook(action, projectDir, io, log, readStdin);
        }
        if (action !== undefined && action !== "status" && action !== "show") {
          log(c.coral(`unknown ${command} action: ${terminalSafeLine(action)} (use on|off)`));
          return 2;
        }
        // autopilot keeps a status view of its own: mode, budget, playbook
        // clamps and recent decisions are too specific for the report's
        // one-line feature row.
        if (command === "autopilot") return autopilotStatusReport(projectDir, io, log);
        log(c.dim(`gradient ${command} status is now part of gradient`));
        for (const line of renderReport(await buildReport(projectDir, { home: io.home }))) log(line);
        return 0;
      }
      case "bundle": {
        const name = positionals[0];
        if (!name) {
          log(c.coral("bundle needs a name: gradient bundle <name>"));
          return 2;
        }
        if (flags["with-hooks"]) {
          log(c.coral("bundle hooks are disabled pending recipient-side consent; omit --with-hooks"));
          return 2;
        }
        const result = await bundleCommand(projectDir, name, { withHooks: !!flags["with-hooks"], home: io.home });
        const displayDir = terminalSafePath(result.dir);
        log(
          displayDir
            ? `${c.ok("bundle written")} ${c.muted(displayDir)}`
            : c.ok("bundle written (path contains control characters; executable command omitted)"),
        );
        for (const file of result.files) log(`  ${c.dim(relative(result.dir, file))}`);
        for (const skipped of result.skipped) {
          log(c.muted(`  skipped ${skipped} (not portable in a plugin — hooks/loops — or needs re-review, or is unreadable/sensitive)`));
        }
        if (displayDir) log(`\n${c.dim("try it:")} claude --plugin-dir ${posixShellQuote(displayDir)}`);

        const pluginName = basename(result.dir);
        log(c.dim("marketplace catalog (current Claude Code schema; place the plugin at the shown relative source):"));
        log(JSON.stringify({
          name: `${pluginName}-marketplace`,
          owner: { name: "YOUR_TEAM" },
          description: "Team workflows packaged by gradient",
          plugins: [{
            name: pluginName,
            source: `./${pluginName}`,
            description: "Workflows mined from real usage by gradient",
          }],
        }, null, 2));
        log(c.dim("Codex marketplace entry (place this bundle at ./plugins/<name> relative to marketplace.json):"));
        log(JSON.stringify({
          name: `${pluginName}-marketplace`,
          interface: { displayName: `${pluginName} workflows` },
          plugins: [{
            name: pluginName,
            source: { source: "local", path: `./plugins/${pluginName}` },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Productivity",
          }],
        }, null, 2));
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
      default:
        log(`${c.coral(`unknown command: ${terminalSafeLine(command)}`)}\n\n${banner(VERSION)}\n\n${HELP}`);
        return 2;
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
