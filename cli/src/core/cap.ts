import type { Turn } from "./types.js";

export interface CapResult<T extends { ts: string } = Turn> {
  kept: T[];
  /** How many prompts were dropped (0 when under the cap). */
  dropped: number;
}

export const MAX_PROMPTS_HARD_CAP = 5_000;

export function boundedPromptLimit(max: number): number {
  if (!Number.isSafeInteger(max) || max <= 0) return MAX_PROMPTS_HARD_CAP;
  return Math.min(max, MAX_PROMPTS_HARD_CAP);
}

function boundedRecencyLimit(max: number, hardCap: number): number {
  const ceiling = Number.isSafeInteger(hardCap) && hardCap > 0 ? hardCap : MAX_PROMPTS_HARD_CAP;
  if (!Number.isSafeInteger(max) || max <= 0) return ceiling;
  return Math.min(max, ceiling);
}

/**
 * Keep only the most recent `max` prompts by timestamp. Clustering is O(n²), so
 * an unbounded cross-project scan can stall; this bounds the work while
 * preferring recent activity. The drop count is returned (never silently
 * truncated). Invalid/non-positive or oversized settings use the absolute
 * safety ceiling rather than disabling it.
 */
export function capByRecency<T extends { ts: string }>(
  items: T[],
  max: number,
  hardCap = MAX_PROMPTS_HARD_CAP,
): CapResult<T> {
  const limit = boundedRecencyLimit(max, hardCap);
  if (items.length <= limit) return { kept: items, dropped: 0 };
  // ISO timestamps sort lexicographically in chronological order; newest first.
  const sorted = [...items].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { kept: sorted.slice(0, limit), dropped: items.length - limit };
}
