import type { Turn } from "./types.js";

export interface CapResult {
  kept: Turn[];
  /** How many prompts were dropped (0 when under the cap). */
  dropped: number;
}

export const MAX_PROMPTS_HARD_CAP = 5_000;

export function boundedPromptLimit(max: number): number {
  if (!Number.isSafeInteger(max) || max <= 0) return MAX_PROMPTS_HARD_CAP;
  return Math.min(max, MAX_PROMPTS_HARD_CAP);
}

/**
 * Keep only the most recent `max` prompts by timestamp. Clustering is O(n²), so
 * an unbounded cross-project scan can stall; this bounds the work while
 * preferring recent activity. The drop count is returned (never silently
 * truncated). Invalid/non-positive or oversized settings use the absolute
 * safety ceiling rather than disabling it.
 */
export function capByRecency(prompts: Turn[], max: number): CapResult {
  const limit = boundedPromptLimit(max);
  if (prompts.length <= limit) return { kept: prompts, dropped: 0 };
  // ISO timestamps sort lexicographically in chronological order; newest first.
  const sorted = [...prompts].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { kept: sorted.slice(0, limit), dropped: prompts.length - limit };
}
