#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface BinaryIo {
  readStdin?: () => Promise<Record<string, unknown>>;
  write?: (chunk: string) => void;
  home?: string;
}

const STDIN_MAX_CHARS = 1_000_000;

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

  const { main } = await import("./cli.js");
  return main(argv, {
    log: line => write(`${line}\n`),
    readStdin: io.readStdin,
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
  runBinary(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
