import { banner, c, gradientText } from "./ui";
import { VERSION } from "./version";
import { runScan } from "./commands/scan";
import { runReview } from "./commands/review";
import { runApply } from "./commands/apply";
import { runList } from "./commands/list";
import { runRemove } from "./commands/remove";
import { runInit } from "./commands/init";
import { runCheckpoint } from "./commands/checkpoint";

export type Args = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): { command: string | undefined; args: Args } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags[a.slice(1)] = true;
    } else {
      positionals.push(a);
    }
  }
  const command = positionals.shift();
  return { command, args: { positionals, flags } };
}

const HELP = `
${banner(VERSION)}

  Reads your Claude Code history, finds what you repeat, and generates the
  automations to stop — slash commands, hooks, and loops. You approve each one.

${c.bold("USAGE")}
  gradient <command> [options]

${c.bold("COMMANDS")}
  ${c.violet("scan")}        Read history, cluster repeats, propose automations  ${c.dim("(read-only)")}
  ${c.violet("review")}      Walk the proposed suggestions and approve the keepers
  ${c.violet("apply")} <id>  Generate a specific suggestion non-interactively
  ${c.violet("list")}        Show artifacts gradient has generated
  ${c.violet("remove")} <n>  Delete a generated artifact (clean uninstall)
  ${c.violet("init")}        Install the /gradient skill and write project config
  ${c.dim("checkpoint")}  Write a progress snapshot ${c.dim("(backs the PreCompact hook)")}

${c.bold("SCAN OPTIONS")}
  --all               Scan every project's history (default: all)
  --project <path>    Limit to one project's transcripts
  --since <dur>       Only turns newer than e.g. 7d, 24h
  --type <kind>       command | loop | hook
  --limit <n>         Max suggestions to print (default: 10)
  --json              Machine-readable output

${c.bold("GLOBAL")}
  -h, --help          Show this help
  -v, --version       Print version

  ${c.dim("docs:")} ${gradientText("https://gradient.md")}
`;

async function main(): Promise<number> {
  const { command, args } = parseArgs(process.argv.slice(2));

  if (args.flags.version || args.flags.v || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!command || args.flags.help || args.flags.h || command === "help") {
    process.stdout.write(`${HELP}\n`);
    return command && command !== "help" ? 1 : 0;
  }

  const handlers: Record<string, (a: Args) => Promise<number>> = {
    scan: runScan,
    review: runReview,
    apply: runApply,
    list: runList,
    remove: runRemove,
    init: runInit,
    checkpoint: runCheckpoint,
  };

  const handler = handlers[command];
  if (!handler) {
    process.stderr.write(
      `${c.coral("unknown command")} "${command}" — run ${c.violet("gradient --help")}\n`,
    );
    return 1;
  }

  try {
    return await handler(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${c.coral("error")} ${msg}\n`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
