import { homedir } from "node:os";
import { join } from "node:path";
import type { Suggestion } from "../core/types.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { loadConfig, projectCacheDir, resolveCheapModel, resolveTargets } from "../config.js";
import { refreshRecallIndex } from "./recall.js";
import { safeReadFile, safeWriteFile } from "../core/safeFs.js";
import { validateSuggestion } from "../core/validate.js";
import { loadManifest } from "../core/manifest.js";
import { writePlaybook } from "../core/playbook.js";

const SUGGESTIONS_MAX_BYTES = 5_000_000;
const SUGGESTIONS_MAX_ENTRIES = 1_000;

export function suggestionsPath(projectDir: string, home?: string): string {
  return join(projectCacheDir(projectDir, home), "suggestions.json");
}

export async function loadSuggestions(
  projectDir: string,
  opts: { home?: string; onSkip?: (message: string) => void } = {},
): Promise<Suggestion[]> {
  const onSkip = opts.onSkip ?? (() => {});
  try {
    const userHome = opts.home ?? homedir();
    const parsed = JSON.parse(await safeReadFile(
      userHome,
      suggestionsPath(projectDir, userHome),
      { maxBytes: SUGGESTIONS_MAX_BYTES },
    )) as unknown;
    if (!Array.isArray(parsed)) return [];
    if (parsed.length > SUGGESTIONS_MAX_ENTRIES) {
      onSkip(`skipping oversized suggestion cache (${parsed.length} entries)`);
      return [];
    }
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function saveSuggestions(
  projectDir: string,
  suggestions: Suggestion[],
  home?: string,
): Promise<void> {
  if (!Array.isArray(suggestions) || suggestions.length > SUGGESTIONS_MAX_ENTRIES) {
    throw new Error(`suggestion cache exceeds ${SUGGESTIONS_MAX_ENTRIES} entry cap`);
  }
  for (const suggestion of suggestions) validateSuggestion(suggestion);
  const data = `${JSON.stringify(suggestions, null, 2)}\n`;
  if (Buffer.byteLength(data, "utf8") > SUGGESTIONS_MAX_BYTES) {
    throw new Error(`suggestion cache exceeds ${SUGGESTIONS_MAX_BYTES} byte cap`);
  }
  const userHome = home ?? homedir();
  await safeWriteFile(userHome, suggestionsPath(projectDir, userHome), data, { mode: 0o600 });
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
  opts: { home?: string; onSkip?: (message: string) => void } = {},
): Promise<ApplyResult[]> {
  const all = await loadSuggestions(projectDir, opts);
  const wanted = all.filter(suggestion => ids.includes(suggestion.id) || ids.includes(suggestion.name));
  const config = await loadConfig(opts.home);
  const emitTarget = config.emitTarget ?? "skill";
  const targets = resolveTargets(config);
  const cheapModel = resolveCheapModel(config);
  const out: ApplyResult[] = [];
  for (const suggestion of wanted) {
    if (suggestion.confidence === "flagged") {
      opts.onSkip?.(`skipping unresolved flagged suggestion: ${suggestion.name}`);
      continue;
    }
    out.push(await applySuggestion(suggestion, projectDir, {
      emitTarget,
      targets,
      cheapModel,
      home: opts.home,
    }));
  }
  if (out.length > 0) {
    await syncApprovedPlaybook(projectDir, all, opts.home);
    await refreshRecallIndex(projectDir, opts.home);
  }
  return out;
}
