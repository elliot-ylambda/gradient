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
  examples: string[][];   // ≤3 raw prompt tuples, one prompt per step
}

interface PairStat { count: number; sessions: Set<string>; examples: string[][] }

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

  const pairs = new Map<string, PairStat>();
  let capped = false;
  for (const [sid, arr] of bySession) {
    arr.sort((a, b) => a.ts.localeCompare(b.ts));
    let prev: { sig: string; text: string } | null = null;
    for (const t of arr) {
      const text = t.text!;
      if (NUDGE_PROMPT_RE.test(text.trim())) continue;      // transparent (spec Decision 2)
      const sig = assign(text);
      if (sig === null) { prev = null; continue; }          // unclustered → chain breaker
      if (prev && prev.sig !== sig) {
        const key = `${prev.sig}\u0000${sig}`;
        let p = pairs.get(key);
        if (!p) {
          if (pairs.size >= SEQ_MAX_BIGRAMS) { capped = true; prev = { sig, text }; continue; }
          p = { count: 0, sessions: new Set(), examples: [] };
          pairs.set(key, p);
        }
        p.count++;
        p.sessions.add(sid);
        if (p.examples.length < 3) p.examples.push([prev.text, text]);
      }
      prev = { sig, text };
    }
  }

  const bigrams: ChainFinding[] = [];
  for (const [key, p] of pairs) {
    if (p.count < SEQ_MIN_COUNT || p.sessions.size < SEQ_MIN_SESSIONS) continue;
    bigrams.push({
      steps: key.split("\u0000"), count: p.count,
      sessions: p.sessions.size, sessionIds: [...p.sessions], examples: p.examples,
    });
  }

  // One merge pass: A→B + B→C with overlapping sessions → A→B→C (spec Decision 3).
  // Standalone bigrams are emitted only after every merge has claimed its pair —
  // a bigram that fails to merge as a left side may still be a later merge's
  // right side, and must not appear both standalone and inside the chain.
  const consumed = new Set<number>();
  const chains: ChainFinding[] = [];
  for (let i = 0; i < bigrams.length; i++) {
    if (consumed.has(i)) continue;
    const ab = bigrams[i];
    for (let j = 0; j < bigrams.length; j++) {
      if (j === i || consumed.has(j)) continue;
      const bc = bigrams[j];
      if (ab.steps[ab.steps.length - 1] !== bc.steps[0]) continue;
      const shared = ab.sessionIds.filter(s => bc.sessionIds.includes(s));
      if (shared.length < SEQ_MIN_SESSIONS) continue;
      chains.push({
        steps: [...ab.steps, ...bc.steps.slice(1)],
        count: Math.min(ab.count, bc.count),
        sessions: shared.length,
        sessionIds: shared,
        examples: ab.examples.map((e, k) => [...e, ...(bc.examples[k]?.slice(1) ?? [])]).slice(0, 3),
      });
      consumed.add(i); consumed.add(j);
      break;
    }
  }
  const leftovers = bigrams.filter((_, i) => !consumed.has(i));
  return { chains: [...chains, ...leftovers].sort((a, b) => b.count - a.count), capped };
}
