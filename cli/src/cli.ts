#!/usr/bin/env node
import { parseArgs } from "node:util";
import { basename, relative } from "node:path";
import { scan } from "./commands/scan.js";
import { review, readlinePrompter } from "./commands/review.js";
import { applyByIds } from "./commands/apply.js";
import { list } from "./commands/list.js";
import { remove } from "./commands/remove.js";
import { init } from "./commands/init.js";
import { checkpoint } from "./commands/checkpoint.js";
import { stats } from "./commands/stats.js";
import { explain } from "./commands/explain.js";
import { respond, type StopHookInput } from "./commands/respond.js";
import { setAutopilotMode, autopilotStatus } from "./commands/autopilot.js";
import { migrate } from "./commands/migrate.js";
import { recallHook, recallStatus, setRecall, type RecallHookInput } from "./commands/recall.js";
import { banner, c, confidenceChip, kindLabel } from "./core/ui.js";
import { spawnDetached } from "./core/spawn.js";
import { resolveScanScope } from "./core/scope.js";
import { isNudge } from "./core/playbook.js";
import { loadConfig, resolveCheapModel, resolveTargets } from "./config.js";
import { VERSION } from "./version.js";
import { insights, writeInsightsHtml } from "./commands/insights.js";
import { continuityStatus, setContinuity } from "./commands/continuity.js";
import { recap } from "./commands/recap.js";
import { bundleCommand } from "./commands/bundle.js";

const HELP = `gradient — turn repeated Claude Code workflows into artifacts

Usage:
  gradient init                 configure + install the /gradient skill
  gradient init --session-scan  also run a scan at the start of each session
  gradient scan                 find repeated prompts, error pastes, and answers
  gradient scan --user          same, all projects, last 7 days (configurable)
  gradient scan --all           same, all projects, no time limit
    [--since 7d] [--limit N] [--max-prompts N]
  gradient review               approve cached suggestions
  gradient apply <id|name>...   generate specific suggestions
  gradient explain <id|name>    show the evidence behind a suggestion
  gradient list                 show generated artifacts
  gradient remove <name>        delete a generated artifact
  gradient migrate [--dry-run]  convert generated commands to skills
  gradient recall <on|off|status>
                                hint when a prompt matches an artifact
  gradient stats                show pattern coverage + artifact adoption
  gradient insights [--user] [--html]
                                behavior report + what to automate next
  gradient continuity <on|off|status>
                                checkpoint before compaction, recap on resume
  gradient bundle <name> [--with-hooks]
                                package approved artifacts as a plugin
  gradient autopilot <off|nudge|full>
                                auto-respond when Claude stops (opt-in)
  gradient autopilot status     mode, budget, and recent auto-responses
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
      detach: { type: "boolean" },
      "dry-run": { type: "boolean" },
      html: { type: "boolean" },
      "with-hooks": { type: "boolean" },
    },
  });
  return { command, positionals, flags: values as Record<string, string | boolean> };
}

function sinceDays(flag: string | boolean | undefined): number | undefined {
  if (typeof flag !== "string") return undefined;
  const m = /^(\d+)d?$/.exec(flag.trim());
  return m ? Number(m[1]) : undefined;
}

export async function main(
  argv: string[],
  io: { log?: (s: string) => void; readStdin?: () => Promise<Record<string, unknown>> } = {},
): Promise<number> {
  const log = io.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const readStdin = io.readStdin ?? readStdinJson;

  if (argv.length === 0) {
    log(`${banner(VERSION)}\n\n${HELP}`);
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

  // parseArgs throws on an unrecognized flag. Catch it here: an unknown option
  // is a usage error like an unknown command, not a crash.
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (e) {
    log(c.coral((e as Error).message.split(".")[0]));
    log(`\n${HELP}`);
    return 2;
  }
  const { command, positionals, flags } = parsed;
  const projectDir = process.cwd();

  try {
    switch (command) {
      case "init": {
        const r = await init({ installSkill: !flags["no-skill"], sessionScan: !!flags["session-scan"], projectDir });
        log(banner(VERSION));
        log(
          `${c.muted("backend:")} ${r.backend}\n${c.muted("config:")} ${r.configPath}\n${c.muted("skill installed:")} ${r.skillInstalled}\n${c.muted("session-start scan:")} ${r.sessionScanInstalled}`,
        );
        return 0;
      }
      case "scan": {
        if (flags.detach) {
          const passthrough = argv.slice(1).filter(a => a !== "--detach");
          spawnDetached(["scan", ...passthrough], projectDir);
          return 0;
        }
        log(banner(VERSION));
        const config = await loadConfig();
        const resolved = resolveScanScope(
          { user: !!flags.user, all: !!flags.all, since: sinceDays(flags.since) },
          config,
        );
        log(c.dim(resolved.label));
        const out = await scan(
          {
            scope: resolved.scope,
            projectPath: projectDir,
            sinceDays: resolved.sinceDays,
            limit: flags.limit ? Number(flags.limit) : undefined,
            maxPrompts: flags["max-prompts"] ? Number(flags["max-prompts"]) : undefined,
          },
          { log, config },
        );
        for (const s of out) {
          log(
            `  ${confidenceChip(s.confidence)} ${c.bold(s.name)}  ${c.muted(s.title)}  ${c.dim(`(seen ${s.evidence.count}×)`)}`,
          );
          if (isNudge(s)) {
            log(`      ${c.dim("tip: this is what autopilot automates →")} ${c.violet("gradient autopilot nudge")}`);
          }
        }
        log(`\n${c.dim("Next:")} ${c.violet("gradient review")}`);
        return 0;
      }
      case "review": {
        const config = await loadConfig();
        const applied = await review(projectDir, readlinePrompter({
          targets: resolveTargets(config),
          cheapModel: resolveCheapModel(config),
        }), { onSkip: log });
        log(`\n${c.ok(`applied ${applied.length} suggestion(s).`)}`);
        for (const a of applied) {
          for (const write of a.writes) {
            log(`${c.ok("wrote")} ${c.muted(write.path)}${write.target === "codex" ? c.dim(" [codex]") : ""}`);
          }
          if (a.printed) log(`  ${c.dim("run:")} ${a.printed}`);
          for (const failure of a.failures) log(c.coral(`  ${failure.target}: ${failure.error}`));
          for (const target of a.skippedTargets) log(c.muted(`  skipped ${target}: artifact type is not portable`));
        }
        return 0;
      }
      case "apply": {
        const applied = await applyByIds(positionals, projectDir, { onSkip: log });
        for (const a of applied) {
          for (const write of a.writes) {
            log(`${c.ok("wrote")} ${c.muted(write.path)}${write.target === "codex" ? c.dim(" [codex]") : ""}`);
          }
          if (a.printed) log(`${c.dim("run:")} ${a.printed}`);
          for (const failure of a.failures) log(c.coral(`${failure.target}: ${failure.error}`));
          for (const target of a.skippedTargets) log(c.muted(`skipped ${target}: artifact type is not portable`));
        }
        return 0;
      }
      case "explain": {
        const s = await explain(projectDir, positionals[0] ?? "", { onSkip: log });
        if (!s) {
          log(c.coral(`no suggestion matching: ${positionals[0] ?? "(none given)"}`));
          return 1;
        }
        log(`${confidenceChip(s.confidence)} ${c.bold(s.name)}  ${c.muted(s.title)}`);
        log(c.dim(s.rationale));
        const sources = s.evidence.assistants?.length === 2
          ? " · sources: Claude Code + Codex"
          : "";
        log(c.dim(`seen ${s.evidence.count}× across ${s.evidence.sessions} sessions${sources}`));
        for (const ex of s.examples ?? []) log(`  ${c.muted("·")} ${ex}`);
        return 0;
      }
      case "list": {
        const entries = await list(projectDir);
        const showTargets = entries.some(entry => entry.target === "codex");
        for (const e of entries) {
          const target = showTargets ? `\t${c.dim(e.target ?? "claude-code")}` : "";
          log(`  ${c.bold(e.name)}\t${kindLabel(e.type)}${target}\t${c.muted(e.path || "(printed)")}\t${c.dim(e.createdAt)}`);
        }
        return 0;
      }
      case "remove": {
        const ok = await remove(projectDir, positionals[0]);
        log(ok ? `${c.ok("removed")} ${positionals[0]}` : c.coral(`no such artifact: ${positionals[0]}`));
        return ok ? 0 : 1;
      }
      case "migrate": {
        const dryRun = !!flags["dry-run"];
        const result = await migrate(projectDir, { dryRun });
        for (const name of result.migrated) {
          log(`${c.ok(dryRun ? "would migrate" : "migrated")} ${name}`);
        }
        for (const name of result.skipped) log(c.muted(`skipped ${name}`));
        log(c.dim(`${result.migrated.length} command(s) ${dryRun ? "ready to migrate" : "migrated"}; ${result.skipped.length} skipped`));
        return 0;
      }
      case "recall": {
        const action = positionals[0];
        if (action === "on" || action === "off") {
          const result = await setRecall(action === "on", projectDir);
          log(
            result.installed
              ? `${c.ok("recall hook installed")} ${c.muted(result.settingsPath)}`
              : `${c.muted("recall hook removed:")} ${result.settingsPath}`,
          );
          return 0;
        }
        if (action === "status") {
          const status = await recallStatus(projectDir);
          const built = status.builtAt ? ` (built ${status.builtAt})` : "";
          log(
            `${c.muted("recall:")} ${status.installed ? c.ok("on") : "off"}  ` +
            c.dim(`index: ${status.entries} artifacts${built}`),
          );
          return 0;
        }
        if (action !== undefined) {
          log(c.coral(`unknown recall action: ${action} (use on|off|status)`));
          return 2;
        }

        // UserPromptSubmit hook mode. Exit 0 always and keep stdout empty
        // unless returning the structured additionalContext payload.
        try {
          const input = await readStdin();
          const result = await recallHook(input as RecallHookInput);
          if (result.context) {
            log(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: result.context,
              },
            }));
          }
        } catch {
          // Fail open: Claude processes the original prompt unchanged.
        }
        return 0;
      }
      case "stats": {
        log(banner(VERSION));
        const r = await stats(projectDir, { onSkip: log });
        log(c.dim(`coverage: ${r.covered}/${r.total} patterns automated (${r.coveragePct}%)`));
        log(c.dim(`session-start scan: ${r.sessionScanEnabled ? "on" : "off"}`));
        for (const p of r.patterns) {
          log(`  ${confidenceChip(p.confidence)} ${c.bold(p.name)}  ${c.dim(`(seen ${p.count}× · ${p.sessions} sessions)`)}  ${p.covered ? c.ok("✓ automated") : c.muted("—")}`);
        }
        if (r.adoption.length > 0) {
          log(c.dim("\nadoption:"));
          for (const artifact of r.adoption) {
            const lastUsed = artifact.lastUsed ? artifact.lastUsed.slice(0, 10) : "never";
            const removal = artifact.suggestRemoval
              ? c.coral(`  → unused 30d+, consider: gradient remove ${artifact.name}`)
              : "";
            log(
              `  ${c.bold(artifact.name)}  ` +
              c.dim(`${artifact.uses} use(s) · last ${lastUsed} · ${artifact.retypesCaught} retype(s) caught`) +
              removal,
            );
          }
        }
        return 0;
      }
      case "insights": {
        log(banner(VERSION));
        const report = await insights({ projectDir, user: !!flags.user });
        const metrics = report.metrics;
        log(c.dim(report.label));
        log(`  ${c.bold("prompts")} ${metrics.prompts}   ${c.bold("nudges")} ${metrics.nudges}   ${c.bold("interrupts")} ${metrics.interrupts}`);
        log(`  ${c.bold("context deaths")} ${metrics.continuations}   ${c.bold("compacts")} ${metrics.compacts}   ${c.bold("error pastes")} ${metrics.errorPastes}`);
        log(`  ${c.bold("model switches")} ${metrics.modelSwitches}   ${c.bold("effort switches")} ${metrics.effortSwitches}`);
        if ((report.costs ?? []).length > 0) {
          log(`\n${c.bold("cost of unautomated habits")}`);
          for (const cost of report.costs ?? []) log(`  ${c.violet("→")} ${cost.line}`);
        }
        log("");
        for (const recommendation of report.recommendations) log(`  ${c.violet("→")} ${recommendation.line}`);
        if (flags.html) log(`${c.ok("wrote")} ${c.muted(await writeInsightsHtml(projectDir, report))}`);
        return 0;
      }
      case "recap": {
        const text = await recap(projectDir);
        if (text) log(text);
        return 0;
      }
      case "continuity": {
        const action = positionals[0] ?? "status";
        if (action === "on" || action === "off") {
          const result = await setContinuity(action === "on", projectDir);
          log(
            result.on
              ? `${c.ok("continuity hooks installed")} ${c.muted(result.settingsPath)}`
              : `${c.muted("continuity hooks removed:")} ${result.settingsPath}`,
          );
          return 0;
        }
        if (action !== "status") {
          log(c.coral(`unknown continuity action: ${action} (use on|off|status)`));
          return 2;
        }
        const status = await continuityStatus(projectDir);
        log(
          `${c.muted("checkpoint (PreCompact):")} ${status.checkpoint ? c.ok("on") : "off"}   ` +
          `${c.muted("recap (SessionStart):")} ${status.recap ? c.ok("on") : "off"}`,
        );
        return 0;
      }
      case "bundle": {
        const name = positionals[0];
        if (!name) {
          log(c.coral("bundle needs a name: gradient bundle <name>"));
          return 2;
        }
        const result = await bundleCommand(projectDir, name, { withHooks: !!flags["with-hooks"] });
        log(`${c.ok("bundle written")} ${c.muted(result.dir)}`);
        for (const file of result.files) log(`  ${c.dim(relative(result.dir, file))}`);
        for (const skipped of result.skipped) log(c.muted(`  skipped ${skipped} (no approved readable artifact)`));
        log(`\n${c.dim("try it:")} claude --plugin-dir ${JSON.stringify(result.dir)}`);

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
        return 0;
      }
      case "checkpoint": {
        const input = await readStdin();
        const path = await checkpoint(input as { transcript_path?: string }, projectDir);
        log(`checkpoint written: ${path}`);
        return 0;
      }
      case "autopilot": {
        const arg = positionals[0] ?? "status";
        if (arg === "off" || arg === "nudge" || arg === "full") {
          const r = await setAutopilotMode(arg, projectDir); // narrowed to AutopilotMode by the condition
          log(banner(VERSION));
          log(`${c.muted("autopilot:")} ${c.bold(r.mode)}`);
          log(
            r.hookInstalled
              ? `${c.ok("Stop hook installed")} ${c.muted(r.settingsPath)}`
              : `${c.muted("Stop hook removed:")} ${r.settingsPath}`,
          );
          return 0;
        }
        if (arg !== "status") {
          log(c.coral(`unknown autopilot mode: ${arg} (use off|nudge|full|status)`));
          return 2;
        }
        const s = await autopilotStatus(projectDir);
        log(banner(VERSION));
        log(`${c.muted("mode:")} ${c.bold(s.mode)}${s.effectiveMode !== s.mode ? c.dim(` → ${s.effectiveMode} here (clamped by project gradient.md)`) : ""}`);
        log(`${c.muted("budget:")} ${s.budget} auto-responses/session${s.effectiveBudget !== s.budget ? c.dim(` → ${s.effectiveBudget} here (clamped by project gradient.md)`) : ""}`);
        log(`${c.muted("gradient.md:")} ${s.playbookPath}${s.playbookExists ? "" : c.dim(" (not yet generated — run gradient scan)")}`);
        log(
          `${c.muted("project gradient.md:")} ${s.projectPlaybookExists
            ? s.projectPlaybookPath + (s.projectMalformed ? c.coral(" (malformed — autopilot off here)") : "")
            : c.dim("none in this repo")}`,
        );
        log(`${c.muted("stop hook here:")} ${s.hookInstalled ? c.ok("installed") : "not installed"}`);
        for (const e of s.recent) {
          log(`  ${c.dim(e.ts)} ${e.action === "continue" ? c.ok("continued") : c.muted("stood down")}  ${c.dim(e.why)}`);
        }
        return 0;
      }
      case "respond": {
        // Stop-hook target. Contract: exit 0 ALWAYS; stdout carries ONLY the
        // block JSON (exit code 2 / stderr would be injected into Claude).
        try {
          const input = await readStdin();
          const r = await respond(input as StopHookInput);
          if (r.decision === "block") log(JSON.stringify({ decision: "block", reason: r.reason }));
        } catch {
          // fail-open: the stop stands
        }
        return 0;
      }
      default:
        log(`${c.coral(`unknown command: ${command}`)}\n\n${banner(VERSION)}\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    log(`gradient: ${(e as Error).message}`);
    return 1;
  }
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Entry point when run as a binary.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
