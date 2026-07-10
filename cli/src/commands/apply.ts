import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Suggestion } from "../core/types.js";
import { gradientDir } from "../core/manifest.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { loadConfig } from "../config.js";
import { refreshRecallIndex } from "./recall.js";
import { validateSuggestion } from "../core/validate.js";

export async function loadSuggestions(
  projectDir: string,
  onSkip: (message: string) => void = () => {},
): Promise<Suggestion[]> {
  try {
    const parsed = JSON.parse(await readFile(join(gradientDir(projectDir), "suggestions.json"), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    const suggestions: Suggestion[] = [];
    for (const candidate of parsed) {
      try {
        validateSuggestion(candidate);
        suggestions.push(candidate);
      } catch (error) {
        onSkip(`skipping invalid cached suggestion: ${(error as Error).message}`);
      }
    }
    return suggestions;
  } catch {
    return [];
  }
}

export async function applyByIds(
  ids: string[],
  projectDir: string,
  opts: { home?: string; onSkip?: (message: string) => void } = {},
): Promise<ApplyResult[]> {
  const all = await loadSuggestions(projectDir, opts.onSkip);
  const wanted = all.filter(s => ids.includes(s.id) || ids.includes(s.name));
  const config = await loadConfig(opts.home);
  const emitTarget = config.emitTarget ?? "skill";
  const out: ApplyResult[] = [];
  for (const s of wanted) out.push(await applySuggestion(s, projectDir, { emitTarget }));
  if (out.length > 0) await refreshRecallIndex(projectDir, opts.home);
  return out;
}
