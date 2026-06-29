import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Args } from "../cli";
import type { Suggestion, Turn } from "../types";
import { VERSION } from "../version";
import { banner, c, chip } from "../ui";
import { collect } from "../core/collect";
import { parse } from "../core/parse";
import { filterTurns } from "../core/filter";
import { cluster } from "../core/cluster";
import { detectNoLLM } from "../core/detect";

function chipFor(s: Suggestion): string {
  if (s.type === "hook") return chip("hook");
  if (s.type === "loop") return chip("loop");
  return chip(s.confidence === "high" ? "high" : "inferred");
}

/** Truncate (with ellipsis) or pad a string to exactly `n` visible chars. */
function fit(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length > n) return `${flat.slice(0, n - 1)}…`;
  return flat + " ".repeat(n - flat.length);
}

export async function runScan(args: Args): Promise<number> {
  const json = Boolean(args.flags.json);
  const limit = Number(args.flags.limit ?? 10) || 10;
  const project =
    typeof args.flags.project === "string" ? args.flags.project : undefined;
  const typeFilter =
    typeof args.flags.type === "string" ? args.flags.type : undefined;

  const files = collect({ project, all: Boolean(args.flags.all) });
  if (files.length === 0) {
    process.stderr.write(
      `${c.coral("no transcripts found")} under ~/.claude/projects — is Claude Code installed?\n`,
    );
    return 1;
  }

  const turns: Turn[] = [];
  let skipped = 0;
  for (const f of files) {
    const r = parse(f);
    for (const t of r.turns) turns.push(t);
    skipped += r.skipped;
  }

  const { prompts, removed } = filterTurns(turns);
  const { candidates, dropped } = cluster(prompts);
  let suggestions = detectNoLLM(candidates);
  if (typeFilter) suggestions = suggestions.filter((s) => s.type === typeFilter);
  const shown = suggestions.slice(0, limit);

  // Cache for `review` / `apply`.
  mkdirSync(join(process.cwd(), ".gradient"), { recursive: true });
  writeFileSync(
    join(process.cwd(), ".gradient", "suggestions.json"),
    `${JSON.stringify(suggestions, null, 2)}\n`,
  );

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          stats: {
            transcripts: files.length,
            prompts: prompts.length,
            removed,
            skipped,
            candidates: candidates.length,
            dropped,
          },
          suggestions: shown,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${banner(VERSION)}`);
  lines.push("");
  lines.push(
    `  ${c.muted("scanning")} ${files.length.toLocaleString()} transcripts · ${prompts.length.toLocaleString()} prompts   ${c.ok("✓")}`,
  );
  lines.push(
    `  ${c.muted("filtering")} ${removed.toLocaleString()} injected/empty · ${skipped.toLocaleString()} malformed skipped   ${c.ok("✓")}`,
  );
  lines.push(
    `  ${c.muted("clustering")} → ${candidates.length} candidates (${dropped} below threshold dropped)   ${c.ok("✓")}`,
  );
  lines.push("");

  if (shown.length === 0) {
    lines.push(`  ${c.muted("no repeated patterns crossed the threshold yet.")}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  }

  lines.push(`  ${c.bold(`${shown.length} automations worth your time`)}`);
  lines.push("");
  for (const s of shown) {
    lines.push(
      `  ${chipFor(s)}  ${c.bold(fit(s.name, 16))}${c.muted(fit(s.title, 34))}${c.dim(`×${s.evidence.count} · ${s.evidence.sessions} sessions`)}`,
    );
  }
  lines.push("");
  lines.push(`  ${c.muted("review them →")} ${c.violet("gradient review")}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
