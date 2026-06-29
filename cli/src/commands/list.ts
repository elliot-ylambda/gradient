import type { Args } from "../cli";
import { c } from "../ui";
import { readManifest } from "../core/manifest";

export async function runList(_args: Args): Promise<number> {
  const entries = readManifest();
  if (entries.length === 0) {
    process.stdout.write(
      `  ${c.muted("no artifacts generated yet — run")} ${c.violet("gradient scan")}\n`,
    );
    return 0;
  }
  const lines = [""];
  for (const e of entries) {
    lines.push(
      `  ${c.bold(e.name)} ${c.dim(`(${e.type})`)}  ${e.path}  ${c.dim(e.createdAt.slice(0, 10))}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
