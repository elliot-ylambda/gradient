import type { Turn } from "./types.js";

export interface CapResult {
  kept: Turn[];
  /** How many prompts were dropped (0 when under the cap). */
  dropped: number;
}

/**
 * Keep only the most recent `max` prompts by timestamp. Clustering is O(n²), so
 * an unbounded cross-project scan can stall; this bounds the work while
 * preferring recent activity. The drop count is returned (never silently
 * truncated) so the caller can report it. `max <= 0` disables the cap.
 */
export function capByRecency(prompts: Turn[], max: number): CapResult {
  if (max <= 0 || prompts.length <= max) return { kept: prompts, dropped: 0 };
  // ISO timestamps sort lexicographically in chronological order; newest first.
  const sorted = [...prompts].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { kept: sorted.slice(0, max), dropped: prompts.length - max };
}
