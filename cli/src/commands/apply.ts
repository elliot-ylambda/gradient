import { join } from "node:path";
import { homedir } from "node:os";
import type { Suggestion } from "../core/types.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { loadConfig, projectCacheDir } from "../config.js";
import { refreshRecallIndex } from "./recall.js";
import { safeReadFile } from "../core/safeFs.js";
import { validateSuggestion } from "../core/validate.js";
import { loadManifest } from "../core/manifest.js";
import { writePlaybook } from "../core/playbook.js";

export function suggestionsPath(projectDir: string, home?: string): string {
  return join(projectCacheDir(projectDir, home), "suggestions.json");
}

export async function loadSuggestions(projectDir: string, home?: string): Promise<Suggestion[]> {
  try {
    const userHome = home ?? homedir();
    const parsed = JSON.parse(await safeReadFile(userHome, suggestionsPath(projectDir, userHome))) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((candidate): candidate is Suggestion => {
      try { validateSuggestion(candidate); return true; } catch { return false; }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function syncApprovedPlaybook(
  projectDir: string,
  suggestions: Suggestion[],
  home?: string,
): Promise<void> {
  const approved = new Set((await loadManifest(projectDir)).map(entry => entry.suggestionId));
  await writePlaybook(suggestions.filter(suggestion => approved.has(suggestion.id)), home);
}

export async function applyByIds(
  ids: string[],
  projectDir: string,
  opts: { home?: string } = {},
): Promise<ApplyResult[]> {
  const all = await loadSuggestions(projectDir, opts.home);
  const wanted = all.filter(s => ids.includes(s.id) || ids.includes(s.name));
  const config = await loadConfig(opts.home);
  const emitTarget = config.emitTarget ?? "skill";
  const out: ApplyResult[] = [];
  for (const s of wanted) out.push(await applySuggestion(s, projectDir, { emitTarget }));
  if (out.length > 0) {
    await syncApprovedPlaybook(projectDir, all, opts.home);
    await refreshRecallIndex(projectDir, opts.home);
  }
  return out;
}
