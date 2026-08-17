import { homedir } from "node:os";
import { join } from "node:path";
import type { Suggestion } from "../core/types.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { loadConfig, projectCacheDir, resolveCheapModel, resolveTargets } from "../config.js";
import { safeReadFile, safeWriteFile } from "../core/safeFs.js";
import { validateSuggestion } from "../core/validate.js";
import { isRestatement } from "../core/restatement.js";
import { loadManifest } from "../core/manifest.js";
import { writePlaybook } from "../core/playbook.js";
import { gradientCommand } from "../core/hookBinary.js";

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
    let restated = 0;
    for (const candidate of parsed) {
      try {
        validateSuggestion(candidate);
        // Re-apply the generation-time filter on read. A cache written by an
        // older release predates whatever the current one rejects, and nothing
        // in the file says which release wrote it — the format is a bare array.
        // Left unfiltered, upgrading silently keeps serving the exact
        // suggestions the upgrade exists to stop producing, right up until the
        // user happens to rescan. This is cheap because isRestatement is a pure
        // predicate over a finished suggestion: no mining state, no model call.
        if (isRestatement(candidate)) {
          restated++;
          continue;
        }
        suggestions.push(candidate);
      } catch (error) {
        onSkip(`skipping invalid cached suggestion: ${(error as Error).message}`);
      }
    }
    if (restated > 0) {
      onSkip(`dropped ${restated} cached suggestion(s) that restate their own prompts; rescan to refresh`);
    }
    return suggestions;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return [];
    // The cache is gradient's own file. Oversized, symlinked, or otherwise
    // unreadable, the right answer is the same as corrupt — no suggestions —
    // not failing every command until the user finds and deletes it themselves.
    // A symlinked cache is the interesting case: refusing to follow it is the
    // security property, and degrading rather than crashing is what keeps that
    // refusal from being a denial of service on the whole CLI.
    if (code === "EFBIG" || code === "ELOOP" || code === "ESYMLINK" || code === "EISDIR") {
      onSkip(`ignoring unreadable suggestion cache: ${(error as Error).message}`);
      return [];
    }
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
  opts: {
    home?: string;
    onSkip?: (message: string) => void;
    onNote?: (message: string) => void;
  } = {},
): Promise<ApplyResult[]> {
  const all = await loadSuggestions(projectDir, opts);
  const wanted = all.filter(suggestion => ids.includes(suggestion.id) || ids.includes(suggestion.name));
  const config = await loadConfig(opts.home);
  const targets = resolveTargets(config);
  const cheapModel = resolveCheapModel(config);
  // Resolved once per run. It no longer carries a caveat to announce: the
  // command is this install's own entry point, which is as durable as gradient.
  const hookBinary = gradientCommand();
  const out: ApplyResult[] = [];
  for (const suggestion of wanted) {
    if (suggestion.confidence === "flagged") {
      opts.onSkip?.(`skipping unresolved flagged suggestion: ${suggestion.name}`);
      continue;
    }
    out.push(await applySuggestion(suggestion, projectDir, {
      targets,
      cheapModel,
      home: opts.home,
      hookBinary,
    }));
  }
  if (out.length > 0) {
    await syncApprovedPlaybook(projectDir, all, opts.home);
  }
  return out;
}
