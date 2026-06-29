import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Args } from "../cli";
import type { Suggestion } from "../types";
import { c } from "../ui";

export function loadSuggestions(): Suggestion[] | null {
  const p = join(process.cwd(), ".gradient", "suggestions.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Suggestion[];
  } catch {
    return null;
  }
}

export async function runReview(_args: Args): Promise<number> {
  const suggestions = loadSuggestions();
  if (!suggestions) {
    process.stderr.write(
      `${c.coral("no scan cache")} — run ${c.violet("gradient scan")} first\n`,
    );
    return 1;
  }
  if (suggestions.length === 0) {
    process.stdout.write(`  ${c.muted("nothing to review.")}\n`);
    return 0;
  }

  const lines: string[] = [""];
  for (const s of suggestions) {
    lines.push(`  ${c.bold(s.name)} ${c.dim(`(${s.type})`)}  ${c.dim(s.id)}`);
    lines.push(`    ${s.title.replace(/\s+/g, " ").slice(0, 72)}`);
    lines.push(
      `    ${c.muted(s.rationale)}  →  ${c.violet(`gradient apply ${s.id}`)}`,
    );
    lines.push("");
  }
  lines.push(
    `  ${c.dim("an interactive approve/skip flow lands in v1; for now, apply by id above.")}`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
