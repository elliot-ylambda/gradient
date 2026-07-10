#!/usr/bin/env node
import { parseArgs } from "node:util";
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
import { banner, c, confidenceChip, kindLabel } from "./core/ui.js";
import { spawnDetached } from "./core/spawn.js";
import { resolveScanScope } from "./core/scope.js";
import { isNudge } from "./core/playbook.js";
import { loadConfig } from "./config.js";
import { VERSION } from "./version.js";

const HELP = `gradient — turn repeated Claude Code workflows into artifacts

Usage:
  gradient init                 configure + install the /gradient skill
  gradient init --session-scan  also run a scan at the start of each session
  gradient scan                 this project, all history
  gradient scan --user          all projects, last 7 days (configurable)
  gradient scan --all           all projects, no time limit
    [--since 7d] [--limit N] [--max-prompts N]
  gradient review               approve cached suggestions
  gradient apply <id|name>...   generate specific suggestions
  gradient explain <id|name>    show the evidence behind a suggestion
  gradient list                 show generated artifacts
  gradient remove <name>        delete a generated artifact
  gradient migrate [--dry-run]  convert generated commands to skills
  gradient stats                show your most-repeated patterns + coverage
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

  const { command, positionals, flags } = parseCliArgs(argv);
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
        const applied = await review(projectDir, readlinePrompter());
        log(`\n${c.ok(`applied ${applied.length} suggestion(s).`)}`);
        for (const a of applied) {
          if (a.printed) log(`  ${c.dim("run:")} ${a.printed}`);
        }
        return 0;
      }
      case "apply": {
        const applied = await applyByIds(positionals, projectDir);
        for (const a of applied) {
          log(a.written ? `${c.ok("wrote")} ${c.muted(a.written)}` : `${c.dim("run:")} ${a.printed}`);
        }
        return 0;
      }
      case "explain": {
        const s = await explain(projectDir, positionals[0] ?? "");
        if (!s) {
          log(c.coral(`no suggestion matching: ${positionals[0] ?? "(none given)"}`));
          return 1;
        }
        log(`${confidenceChip(s.confidence)} ${c.bold(s.name)}  ${c.muted(s.title)}`);
        log(c.dim(s.rationale));
        log(c.dim(`seen ${s.evidence.count}× across ${s.evidence.sessions} sessions`));
        for (const ex of s.examples ?? []) log(`  ${c.muted("·")} ${ex}`);
        return 0;
      }
      case "list": {
        for (const e of await list(projectDir)) {
          log(`  ${c.bold(e.name)}\t${kindLabel(e.type)}\t${c.muted(e.path || "(printed)")}\t${c.dim(e.createdAt)}`);
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
      case "stats": {
        log(banner(VERSION));
        const r = await stats(projectDir);
        log(c.dim(`coverage: ${r.covered}/${r.total} patterns automated (${r.coveragePct}%)`));
        log(c.dim(`session-start scan: ${r.sessionScanEnabled ? "on" : "off"}`));
        for (const p of r.patterns) {
          log(`  ${confidenceChip(p.confidence)} ${c.bold(p.name)}  ${c.dim(`(seen ${p.count}× · ${p.sessions} sessions)`)}  ${p.covered ? c.ok("✓ automated") : c.muted("—")}`);
        }
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
        log(`${c.muted("mode:")} ${c.bold(s.mode)}`);
        log(`${c.muted("budget:")} ${s.budget} auto-responses/session`);
        log(`${c.muted("playbook:")} ${s.playbookPath}${s.playbookExists ? "" : c.dim(" (not yet generated — run gradient scan)")}`);
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
