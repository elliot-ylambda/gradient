import type { ManifestEntry, Suggestion } from "../core/types.js";
import { loadManifest } from "../core/manifest.js";
import { isDismissed, loadDismissed, type Dismissal } from "../core/dismiss.js";
import { spawnDetached } from "../core/spawn.js";
import { stripUnsafeControls } from "../core/security.js";
import { loadSuggestions } from "./apply.js";

export const MIN_SURFACE_MINUTES = 5;

export interface SessionStartDeps {
  home?: string;
  loadSuggestionsFn?: (projectDir: string, opts: { home?: string }) => Promise<Suggestion[]>;
  loadManifestFn?: (projectDir: string) => Promise<ManifestEntry[]>;
  loadDismissedFn?: (projectDir: string) => Promise<Dismissal[]>;
  spawnDetachedFn?: typeof spawnDetached;
  write?: (line: string) => void;
}

function oneLine(value: string): string {
  return stripUnsafeControls(value).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

export function topSurfaceableSuggestion(
  suggestions: Suggestion[],
  manifest: ManifestEntry[],
  dismissed: Dismissal[],
): Suggestion | undefined {
  const applied = new Set(manifest.map(entry => entry.suggestionId));
  return suggestions
    .filter(suggestion =>
      !applied.has(suggestion.id) &&
      !isDismissed(suggestion, dismissed) &&
      (suggestion.evidence.estMinutesSavedPerMonth ?? 0) >= MIN_SURFACE_MINUTES)
    .sort((left, right) =>
      (right.evidence.estMinutesSavedPerMonth ?? 0) - (left.evidence.estMinutesSavedPerMonth ?? 0) ||
      right.evidence.count - left.evidence.count ||
      left.name.localeCompare(right.name))[0];
}

/** SessionStart must be silent and fail-open on every read/write/spawn error.
 * The cached nudge is emitted before the detached rescan starts, so displaying
 * it never waits on transcript collection or an LLM. */
export async function sessionStart(projectDir: string, deps: SessionStartDeps = {}): Promise<void> {
  let line: string | undefined;
  try {
    const [suggestions, manifest, dismissed] = await Promise.all([
      (deps.loadSuggestionsFn ?? loadSuggestions)(projectDir, { home: deps.home }),
      (deps.loadManifestFn ?? loadManifest)(projectDir),
      (deps.loadDismissedFn ?? loadDismissed)(projectDir),
    ]);
    const suggestion = topSurfaceableSuggestion(suggestions, manifest, dismissed);
    if (suggestion) {
      const minutes = suggestion.evidence.estMinutesSavedPerMonth!;
      line = `gradient: ${oneLine(suggestion.title)} (≈${minutes}m/month) — run \`gradient review\``;
    }
  } catch {
    // Invalid or unavailable cache/state produces no hook output.
  }

  if (line) {
    try {
      (deps.write ?? (value => process.stdout.write(`${value}\n`)))(line);
    } catch {
      // A broken output stream must not block session startup or the rescan.
    }
  }
  try {
    (deps.spawnDetachedFn ?? spawnDetached)(["scan"], projectDir);
  } catch {
    // Fail open: the next session starts even when the background scan cannot.
  }
}
