import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Suggestion } from "../core/types.js";
import { gradientDir } from "../core/manifest.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { loadConfig } from "../config.js";
import { refreshRecallIndex } from "./recall.js";

export async function loadSuggestions(projectDir: string): Promise<Suggestion[]> {
  try {
    return JSON.parse(await readFile(join(gradientDir(projectDir), "suggestions.json"), "utf8")) as Suggestion[];
  } catch {
    return [];
  }
}

export async function applyByIds(
  ids: string[],
  projectDir: string,
  opts: { home?: string } = {},
): Promise<ApplyResult[]> {
  const all = await loadSuggestions(projectDir);
  const wanted = all.filter(s => ids.includes(s.id) || ids.includes(s.name));
  const config = await loadConfig(opts.home);
  const emitTarget = config.emitTarget ?? "skill";
  const out: ApplyResult[] = [];
  for (const s of wanted) out.push(await applySuggestion(s, projectDir, { emitTarget }));
  if (out.length > 0) await refreshRecallIndex(projectDir, opts.home);
  return out;
}
