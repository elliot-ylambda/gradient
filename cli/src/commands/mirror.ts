import { homedir } from "node:os";
import type { Config, ManifestEntry, Suggestion } from "../core/types.js";
import { isDismissed, loadDismissed, type Dismissal } from "../core/dismiss.js";
import { loadManifest } from "../core/manifest.js";
import { safeFileMtimeMs } from "../core/safeFs.js";
import { stripUnsafeControls } from "../core/security.js";
import { DEFAULT_USER_SCOPE_DAYS } from "../core/scope.js";
import { loadConfig } from "../config.js";
import { loadSuggestions, suggestionsPath } from "./apply.js";
import { scan } from "./scan.js";

export const MIRROR_MAX_AGE_MS = 86_400_000;
export const MIRROR_MAX_SUGGESTIONS = 3;

export interface MirrorDeps {
  home?: string;
  now?: number;
  write?: (line: string) => void;
  loadSuggestionsFn?: (projectDir: string, opts: { home?: string }) => Promise<Suggestion[]>;
  loadManifestFn?: (projectDir: string) => Promise<ManifestEntry[]>;
  loadDismissedFn?: (projectDir: string) => Promise<Dismissal[]>;
  loadConfigFn?: (home?: string) => Promise<Config>;
  cacheMtimeFn?: (projectDir: string, home?: string) => Promise<number>;
  scanFn?: typeof scan;
}

async function suggestionsMtimeMs(projectDir: string, home?: string): Promise<number> {
  const userHome = home ?? homedir();
  return safeFileMtimeMs(userHome, suggestionsPath(projectDir, userHome));
}

function oneLine(value: string): string {
  return stripUnsafeControls(value).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

export function visibleMirrorSuggestions(
  suggestions: Suggestion[],
  manifest: ManifestEntry[],
  dismissed: Dismissal[],
): Suggestion[] {
  const applied = new Set(manifest.map(entry => entry.suggestionId));
  return suggestions
    .filter(suggestion => !applied.has(suggestion.id) && !isDismissed(suggestion, dismissed))
    .sort((left, right) =>
      (right.evidence.estMinutesSavedPerMonth ?? 0) - (left.evidence.estMinutesSavedPerMonth ?? 0) ||
      right.evidence.count - left.evidence.count ||
      left.name.localeCompare(right.name))
    .slice(0, MIRROR_MAX_SUGGESTIONS);
}

export async function mirror(projectDir: string, deps: MirrorDeps = {}): Promise<void> {
  const now = deps.now ?? Date.now();
  let fresh = false;
  try {
    const mtime = await (deps.cacheMtimeFn ?? suggestionsMtimeMs)(projectDir, deps.home);
    const age = now - mtime;
    fresh = Number.isFinite(age) && age >= 0 && age < MIRROR_MAX_AGE_MS;
  } catch {
    // Missing/unreadable cache falls through to a bounded user-scope scan.
  }

  let suggestions: Suggestion[];
  if (fresh) {
    suggestions = await (deps.loadSuggestionsFn ?? loadSuggestions)(projectDir, { home: deps.home });
  } else {
    const config = await (deps.loadConfigFn ?? loadConfig)(deps.home);
    suggestions = await (deps.scanFn ?? scan)({
      scope: "all",
      projectPath: projectDir,
      sinceDays: config.userScopeDays ?? DEFAULT_USER_SCOPE_DAYS,
      home: deps.home,
    }, { config, log: () => {} });
  }

  const [manifest, dismissed] = await Promise.all([
    (deps.loadManifestFn ?? loadManifest)(projectDir),
    (deps.loadDismissedFn ?? loadDismissed)(projectDir),
  ]);
  const visible = visibleMirrorSuggestions(suggestions, manifest, dismissed);
  const write = deps.write ?? (line => process.stdout.write(`${line}\n`));
  if (visible.length === 0) {
    write("gradient: no pending suggestions");
    return;
  }
  for (const suggestion of visible) {
    const leverage = suggestion.evidence.estMinutesSavedPerMonth;
    write(
      `  ${oneLine(suggestion.name)} — ${oneLine(suggestion.title)}` +
      (leverage !== undefined ? ` (≈${leverage}m/mo)` : ""),
    );
  }
  write("review or dismiss them with `gradient review`");
}
