import type { Turn } from "./types.js";

export const SEQ_MIN_COUNT = 3;
export const SEQ_MIN_SESSIONS = 2;
export const SEQ_MAX_BIGRAMS = 2000;

/** Whole-prompt nudges only — "continue the migration" is content, not a nudge. */
export const NUDGE_PROMPT_RE =
  /^(continue|keep going|go( on)?|next|what'?s next|proceed|carry on|resume|ok(ay)?|yes|y|do it)[.!?\s]*$/i;

/** A recurring ordered chain of cluster signatures (spec §3). */
export interface ChainFinding {
  steps: string[];
  count: number;
  sessions: number;
  sessionIds: string[];
  occurrences: { ts: string; sessionId: string }[];
  examples: string[][];   // ≤3 raw prompt tuples, one prompt per step
}

interface NgramStat {
  steps: string[];
  count: number;
  sessions: Set<string>;
  occurrences: { ts: string; sessionId: string }[];
  examples: string[][];
}

export function mineSequences(
  turns: Turn[],
  assign: (text: string) => string | null,
): { chains: ChainFinding[]; capped: boolean } {
  const bySession = new Map<string, Turn[]>();
  for (const t of turns) {
    if (t.role !== "user" || !t.text) continue;
    const arr = bySession.get(t.sessionId) ?? [];
    arr.push(t);
    bySession.set(t.sessionId, arr);
  }

  const ngrams = new Map<string, NgramStat>();
  let capped = false;
  for (const [sid, arr] of bySession) {
    arr.sort((a, b) => a.ts.localeCompare(b.ts));
    let segment: Array<{ sig: string; text: string; ts: string }> = [];
    for (const t of arr) {
      const text = t.text!;
      if (NUDGE_PROMPT_RE.test(text.trim())) continue;      // transparent (spec Decision 2)
      const sig = assign(text);
      if (sig === null) { segment = []; continue; }          // unclustered → chain breaker
      if (segment.at(-1)?.sig === sig) continue;              // A→A is not a workflow edge
      segment.push({ sig, text: text.slice(0, 2_000), ts: t.ts });
      if (segment.length > 3) segment = segment.slice(-3);

      for (const size of [2, 3]) {
        if (segment.length < size) continue;
        const occurrence = segment.slice(-size);
        const steps = occurrence.map(item => item.sig);
        const key = JSON.stringify(steps);
        let stat = ngrams.get(key);
        if (!stat) {
          if (ngrams.size >= SEQ_MAX_BIGRAMS) { capped = true; continue; }
          stat = { steps, count: 0, sessions: new Set(), occurrences: [], examples: [] };
          ngrams.set(key, stat);
        }
        stat.count++;
        stat.sessions.add(sid);
        stat.occurrences.push({ ts: occurrence[occurrence.length - 1].ts, sessionId: sid });
        if (stat.examples.length < 3) stat.examples.push(occurrence.map(item => item.text));
      }
    }
  }

  const supported = [...ngrams.values()].filter(stat =>
    stat.count >= SEQ_MIN_COUNT && stat.sessions.size >= SEQ_MIN_SESSIONS,
  );
  const triples = supported.filter(stat => stat.steps.length === 3);
  const claimedBigrams = new Set(triples.flatMap(stat => [
    JSON.stringify(stat.steps.slice(0, 2)),
    JSON.stringify(stat.steps.slice(1)),
  ]));
  const selected = supported.filter(stat =>
    stat.steps.length === 3 || !claimedBigrams.has(JSON.stringify(stat.steps)),
  );
  const chains = selected.map(stat => ({
    steps: stat.steps,
    count: stat.count,
    sessions: stat.sessions.size,
    sessionIds: [...stat.sessions].sort(),
    occurrences: stat.occurrences,
    examples: stat.examples,
  }));
  return { chains: chains.sort((a, b) => b.count - a.count || b.steps.length - a.steps.length), capped };
}
