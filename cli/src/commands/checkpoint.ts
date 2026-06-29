import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Args } from "../cli";
import { c } from "../ui";

function gitBranch(): string | undefined {
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    });
    if (r.status === 0) return r.stdout.trim() || undefined;
  } catch {
    /* not a git repo — fine */
  }
  return undefined;
}

/**
 * Hook-helper verb (spec §5): a generated PreCompact hook runs `gradient
 * checkpoint` to snapshot progress before Claude Code compacts the context.
 * Not a primary user command — kept tiny and dependency-free.
 */
export async function runCheckpoint(_args: Args): Promise<number> {
  const cwd = process.cwd();
  const file = join(cwd, "progress.md");
  const branch = gitBranch();
  const stamp = new Date().toISOString();

  const block =
    `\n## Checkpoint — ${stamp}\n\n` +
    `- project: \`${basename(cwd)}\`\n` +
    (branch ? `- branch: \`${branch}\`\n` : "") +
    `- written by \`gradient checkpoint\` before a context compaction\n`;

  if (existsSync(file)) {
    appendFileSync(file, block);
  } else {
    writeFileSync(file, `# Progress\n${block}`);
  }

  process.stdout.write(`  ${c.ok("✓")} checkpoint → ${c.bold("progress.md")}\n`);
  return 0;
}
