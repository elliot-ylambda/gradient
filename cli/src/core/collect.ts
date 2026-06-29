import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync, readdirSync } from "node:fs";

export type CollectOptions = { project?: string; all?: boolean };

/** Root where Claude Code stores per-project transcript history. */
export function transcriptRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/** scope → transcript file paths. Pure I/O, no parsing. */
export function collect(opts: CollectOptions = {}): string[] {
  const root = transcriptRoot();
  if (!existsSync(root)) return [];

  const files = readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(root, f));

  if (opts.project) {
    const needle = basename(opts.project);
    return files.filter((f) => f.includes(needle));
  }
  return files;
}
