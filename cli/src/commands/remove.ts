import { existsSync, rmSync } from "node:fs";
import type { Args } from "../cli";
import { c } from "../ui";
import { removeEntry } from "../core/manifest";
import { assertInside } from "../core/security";

export async function runRemove(args: Args): Promise<number> {
  const name = args.positionals[0];
  if (!name) {
    process.stderr.write(`usage: ${c.violet("gradient remove <name>")}\n`);
    return 1;
  }
  const entry = removeEntry(name);
  if (!entry) {
    process.stderr.write(`${c.coral("not found")}: ${name}\n`);
    return 1;
  }

  // Only delete real files we wrote inside the project (loops/hooks have no file).
  if (entry.path && !entry.path.includes("(")) {
    try {
      const target = assertInside(process.cwd(), entry.path);
      if (existsSync(target)) rmSync(target);
    } catch {
      // path containment failed — leave the file, just drop the manifest entry.
    }
  }
  process.stdout.write(`  ${c.ok("✓")} removed ${c.bold(name)}\n`);
  return 0;
}
