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
import { banner, c, confidenceChip, kindLabel } from "./core/ui.js";
import { resolveScanScope } from "./core/scope.js";
import { loadConfig } from "./config.js";
import { VERSION } from "./version.js";

const HELP = `gradient — turn repeated Claude Code workflows into artifacts

Usage:
  gradient init                 configure + install the /gradient skill
  gradient scan                 this project, all history
  gradient scan --user          all projects, last 7 days (configurable)
  gradient scan --all           all projects, no time limit
    [--since 7d] [--limit N] [--max-prompts N]
  gradient review               approve cached suggestions
  gradient apply <id|name>...   generate specific suggestions
  gradient explain <id|name>    show the evidence behind a suggestion
  gradient list                 show generated artifacts
  gradient remove <name>        delete a generated artifact
  gradient stats                show your most-repeated patterns + coverage
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
  io: { log?: (s: string) => void } = {},
): Promise<number> {
  const log = io.log ?? ((s: string) => process.stdout.write(s + "\n"));

  if (argv.length === 0) {
    log(`${banner(VERSION)}\n\n${HELP}`);
    return 0;
  }

  const { command, positionals, flags } = parseCliArgs(argv);
  const projectDir = process.cwd();

  try {
    switch (command) {
      case "init": {
        const r = await init({ installSkill: !flags["no-skill"] });
        log(banner(VERSION));
        log(
          `${c.muted("backend:")} ${r.backend}\n${c.muted("config:")} ${r.configPath}\n${c.muted("skill installed:")} ${r.skillInstalled}`,
        );
        return 0;
      }
      case "scan": {
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
      case "stats": {
        log(banner(VERSION));
        const r = await stats(projectDir);
        log(c.dim(`coverage: ${r.covered}/${r.total} patterns automated (${r.coveragePct}%)`));
        for (const p of r.patterns) {
          log(`  ${confidenceChip(p.confidence)} ${c.bold(p.name)}  ${c.dim(`(seen ${p.count}× · ${p.sessions} sessions)`)}  ${p.covered ? c.ok("✓ automated") : c.muted("—")}`);
        }
        return 0;
      }
      case "checkpoint": {
        const input = await readStdinJson();
        const path = await checkpoint(input, projectDir);
        log(`checkpoint written: ${path}`);
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

async function readStdinJson(): Promise<{ transcript_path?: string }> {
  if (process.stdin.isTTY) return {};
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  try {
    return JSON.parse(data) as { transcript_path?: string };
  } catch {
    return {};
  }
}

// Entry point when run as a binary.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
