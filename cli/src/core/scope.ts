import type { Config } from "./types.js";

/** Default recency window for `scan --user` (days). */
export const DEFAULT_USER_SCOPE_DAYS = 7;
/** Default ceiling on prompts entering O(n²) clustering. */
export const DEFAULT_MAX_PROMPTS = 1500;
/** Default number of candidates passed to the LLM detect step. */
export const DEFAULT_DETECT_WINDOW = 24;

export interface ScopeFlags {
  /** --user: every project, bounded to a recent window. */
  user?: boolean;
  /** --all: every project, no time bound (the heavy escape hatch). */
  all?: boolean;
  /** --since, already parsed to a day count (undefined if not given). */
  since?: number;
}

export interface ResolvedScope {
  scope: "project" | "all";
  sinceDays?: number;
  /** Human-readable description of what's being scanned, for the CLI header. */
  label: string;
}

/**
 * Translate the scope flags into a concrete (scope, window) pair.
 *
 * Precedence: an explicit --since always wins; otherwise --all is unbounded,
 * --user falls back to the configured default window, and the bare default is
 * the current project with no window. "User scope" is intentionally just
 * "all projects + a default window" so it reuses collect's existing path.
 */
export function resolveScanScope(flags: ScopeFlags, config: Config = {}): ResolvedScope {
  if (flags.all) {
    return {
      scope: "all",
      sinceDays: flags.since,
      label: flags.since ? `all projects · last ${flags.since}d` : "all projects · no time limit",
    };
  }
  if (flags.user) {
    const days = flags.since ?? config.userScopeDays ?? DEFAULT_USER_SCOPE_DAYS;
    return { scope: "all", sinceDays: days, label: `user scope · last ${days}d` };
  }
  return {
    scope: "project",
    sinceDays: flags.since,
    label: flags.since ? `project scope · last ${flags.since}d` : "project scope · all history",
  };
}
