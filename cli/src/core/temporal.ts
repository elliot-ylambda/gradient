import type { Turn, Candidate } from "./types.js";
import { normalize } from "./cluster.js";

/** Whole days between first and last occurrence, one decimal. */
export function spanDays(occurrences: { ts: string }[]): number {
  const ts = occurrences.map(o => Date.parse(o.ts)).filter(Number.isFinite).sort((a, b) => a - b);
  return ts.length > 1 ? Math.round(((ts[ts.length - 1] - ts[0]) / 86_400_000) * 10) / 10 : 0;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Sets c.temporal on every candidate. A "run" is a streak of consecutive user
 * prompts within one session that all belong to the same cluster (any
 * non-member prompt in between breaks the run).
 */
export function annotateTemporal(prompts: Turn[], candidates: Candidate[]): void {
  const byMember = new Map<string, number>();
  candidates.forEach((c, i) => { for (const sig of c.memberSignatures) byMember.set(sig, i); });

  const maxRun = new Array<number>(candidates.length).fill(1);
  const runSessions: Set<string>[] = candidates.map(() => new Set());

  const bySession = new Map<string, Turn[]>();
  for (const t of prompts) {
    if (!t.text) continue;
    const arr = bySession.get(t.sessionId) ?? [];
    arr.push(t);
    bySession.set(t.sessionId, arr);
  }
  for (const [sessionId, turns] of bySession) {
    const ordered = [...turns].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let prev = -1, run = 0;
    for (const t of ordered) {
      const idx = byMember.get(normalize(t.text!)) ?? -1;
      run = idx >= 0 && idx === prev ? run + 1 : 1;
      if (idx >= 0) {
        if (run > maxRun[idx]) maxRun[idx] = run;
        if (run >= 2) runSessions[idx].add(sessionId);
      }
      prev = idx;
    }
  }

  candidates.forEach((c, i) => {
    const ts = c.occurrences.map(o => Date.parse(o.ts)).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let j = 1; j < ts.length; j++) gaps.push((ts[j] - ts[j - 1]) / 60_000);
    c.temporal = {
      maxRunLength: maxRun[i],
      runSessions: runSessions[i].size,
      medianGapMinutes: Math.round(median(gaps)),
      distinctDays: new Set(c.occurrences.map(o => o.ts.slice(0, 10))).size,
      spanDays: spanDays(c.occurrences),
    };
  });
}
