#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BinaryIo {
  readStdin?: () => Promise<Record<string, unknown>>;
  write?: (chunk: string) => void;
  home?: string;
  cwd?: string;
}

const STDIN_MAX_CHARS = 1_000_000;

/** Optional state-root override for isolated installs, CI, and dogfooding.
 * A relative value is resolved from the invoking process's cwd so every
 * downstream safe-fs boundary still receives an absolute root. */
export function gradientHomeFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.GRADIENT_HOME?.trim();
  return configured ? resolve(configured) : undefined;
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > STDIN_MAX_CHARS) return {};
  }
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Lightweight binary dispatcher: the latency-sensitive hook avoids loading
 * the full CLI and its LLM dependencies. */
export async function runBinary(argv: string[], io: BinaryIo = {}): Promise<number> {
  const write = io.write ?? (chunk => process.stdout.write(chunk));

  if (argv.length === 1 && argv[0] === "recall") {
    try {
      const [{ recallHook }, input] = await Promise.all([
        import("./commands/recall.js"),
        (io.readStdin ?? readStdinJson)(),
      ]);
      const result = await recallHook(input, { home: io.home });
      if (result.context) {
        write(`${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: result.context,
          },
        })}\n`);
      }
    } catch {
      // Fail open: no output, successful exit, original prompt continues.
    }
    return 0;
  }

  if (argv.length === 1 && argv[0] === "notify") {
    try {
      const [{ notify }] = await Promise.all([
        import("./commands/notify.js"),
        (io.readStdin ?? readStdinJson)(),
      ]);
      await notify();
    } catch {
      // Fail open and silent: desktop notification support is advisory.
    }
    return 0;
  }

  if (argv.length === 1 && argv[0] === "session-start") {
    try {
      const { sessionStart } = await import("./commands/sessionStart.js");
      await sessionStart(io.cwd ?? process.cwd(), {
        home: io.home,
        write: line => write(`${line}\n`),
      });
    } catch {
      // Fail open and silent: SessionStart must never block the host assistant.
    }
    return 0;
  }

  const { main } = await import("./cli.js");
  return main(argv, {
    log: line => write(`${line}\n`),
    readStdin: io.readStdin,
    home: io.home,
  });
}

/** npm launches bins through a symlink in node_modules/.bin. Compare canonical
 * paths so the installed command actually enters the dispatcher on Unix. */
export function isEntrypoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  runBinary(process.argv.slice(2), { home: gradientHomeFromEnv() }).then(code => {
    process.exitCode = code;
  });
}
