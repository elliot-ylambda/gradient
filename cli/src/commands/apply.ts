import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Args } from "../cli";
import { c } from "../ui";
import { loadSuggestions } from "./review";
import { validateSuggestion } from "../core/validate";
import { assertInside } from "../core/security";
import { addEntry } from "../core/manifest";

export async function runApply(args: Args): Promise<number> {
  const ids = args.positionals;
  if (ids.length === 0) {
    process.stderr.write(`usage: ${c.violet("gradient apply <id…>")}\n`);
    return 1;
  }
  const suggestions = loadSuggestions();
  if (!suggestions) {
    process.stderr.write(
      `${c.coral("no scan cache")} — run ${c.violet("gradient scan")} first\n`,
    );
    return 1;
  }

  let applied = 0;
  for (const id of ids) {
    const s = suggestions.find((x) => x.id === id || x.name === id);
    if (!s) {
      process.stderr.write(`${c.coral("not found")}: ${id}\n`);
      continue;
    }
    validateSuggestion(s);
    const now = new Date().toISOString();

    if (s.artifact.kind === "command") {
      const target = assertInside(process.cwd(), s.artifact.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, s.artifact.content);
      addEntry({ name: s.name, type: s.type, path: s.artifact.path, createdAt: now, suggestionId: s.id });
      process.stdout.write(`  ${c.ok("✓")} wrote ${c.bold(s.artifact.path)}\n`);
      applied++;
    } else if (s.artifact.kind === "loop") {
      process.stdout.write(
        `  ${c.ok("✓")} loop ready — paste into Claude Code:\n    ${c.violet(s.artifact.command)}\n`,
      );
      addEntry({ name: s.name, type: s.type, path: "(loop — run manually)", createdAt: now, suggestionId: s.id });
      applied++;
    } else {
      // Never auto-edit settings.json — print the patch for the user to merge.
      process.stdout.write(
        `  ${c.ok("✓")} hook patch — merge into ${c.bold(".claude/settings.json")}:\n${s.artifact.settingsPatch}\n`,
      );
      addEntry({ name: s.name, type: s.type, path: ".claude/settings.json (hook)", createdAt: now, suggestionId: s.id });
      applied++;
    }
  }

  return applied > 0 ? 0 : 1;
}
