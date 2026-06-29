import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Args } from "../cli";
import { VERSION } from "../version";
import { c } from "../ui";

const SKILL = `---
name: gradient
description: Surface and apply gradient's automation suggestions for this project. Use when the user wants to find repeated Claude Code workflows or generate slash-commands, hooks, or loops from their history.
---

# gradient

Run \`npx gradient scan\` to read history and propose automations, then
\`npx gradient review\` to inspect them and \`npx gradient apply <id>\` to generate
the approved artifact. gradient only ever suggests — the user enables each one.
`;

export async function runInit(_args: Args): Promise<number> {
  // 1. The tool's own install target (separate from artifacts it generates).
  const skillDir = join(homedir(), ".claude", "skills", "gradient");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), SKILL);

  // 2. Project-local config.
  const cfgDir = join(process.cwd(), ".gradient");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, "config.json"),
    `${JSON.stringify({ version: VERSION, createdAt: new Date().toISOString() }, null, 2)}\n`,
  );

  process.stdout.write(
    [
      `  ${c.ok("✓")} installed the ${c.violet("/gradient")} skill → ${join("~", ".claude", "skills", "gradient", "SKILL.md")}`,
      `  ${c.ok("✓")} wrote project config → ${join(".gradient", "config.json")}`,
      "",
      `  next: ${c.violet("gradient scan")}`,
      "",
    ].join("\n"),
  );
  return 0;
}
