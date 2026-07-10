#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export interface BinaryIo {
  readStdin?: () => Promise<Record<string, unknown>>;
  write?: (chunk: string) => void;
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
      const result = await recallHook(input);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBinary(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
