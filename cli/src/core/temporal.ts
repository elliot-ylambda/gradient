import type { Turn, Candidate } from "./types.js";
import { normalize } from "./cluster.js";

function sortedTimestamps(occurrences: { ts: string }[]): number[] {
  return occurrences
    .map(occurrence => Date.parse(occurrence.ts))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
}

function spanFromSorted(ts: number[]): number {
  return ts.length > 1
    ? Math.round(((ts[ts.length - 1] - ts[0]) / 86_400_000) * 10) / 10
    : 0;
}

/** Whole days between first and last occurrence, one decimal. */
export function spanDays(occurrences: { ts: string }[]): number {
  return spanFromSorted(sortedTimestamps(occurrences));
}

export const WINDOW_MS = 86_400_000;

/**
 * How many separate occasions the occurrences represent: walk them in order and
 * open a new window whenever one falls more than 24h after the window it would
 * otherwise join.
 *
 * `distinctDays` counts UTC calendar days, which answers a different question
 * and gets the answer wrong at the boundary — two sends 51 seconds apart read as
 * two active days if midnight fell between them, which is exactly how the
 * dogfood corpus's top prompt-derived candidate survived the single-day gate.
 * Calendar days remain the right unit for deriving a cadence ("daily at 09:00");
 * they are the wrong unit for asking whether something recurred.
 */
export function activeWindows(occurrences: { ts: string }[]): number {
  const ts = sortedTimestamps(occurrences);
  if (ts.length === 0) return 0;
  let windows = 1;
  let start = ts[0];
  for (const timestamp of ts) {
    if (timestamp - start > WINDOW_MS) {
      windows++;
      start = timestamp;
    }
  }
  return windows;
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

  const maxRun = new Array<number>(candidates.length).fill(0);
  const runSessions: Set<string>[] = candidates.map(() => new Set());

  const bySession = new Map<string, Turn[]>();
  for (const t of prompts) {
    if (t.role !== "user" || !t.text) continue;
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
    const ts = sortedTimestamps(c.occurrences);
    const gaps: number[] = [];
    for (let j = 1; j < ts.length; j++) gaps.push((ts[j] - ts[j - 1]) / 60_000);
    c.temporal = {
      maxRunLength: maxRun[i],
      runSessions: runSessions[i].size,
      medianGapMinutes: Math.round(median(gaps)),
      distinctDays: new Set(ts.map(timestamp => new Date(timestamp).toISOString().slice(0, 10))).size,
      spanDays: spanFromSorted(ts),
    };
  });
}
