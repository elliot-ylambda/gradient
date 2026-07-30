import type { Turn, Candidate, Confidence } from "./types.js";
import { minhash, bandKeys } from "./lsh.js";

export function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.!?,;:]+$/g, "").trim();
}

export function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/**
 * Collapse prompts a forked or resumed session replayed from its parent.
 *
 * A resumed session inherits its parent's turns verbatim, timestamp included,
 * so one typed prompt can present as N occurrences across N session ids. Two
 * genuinely separate sends are milliseconds apart at worst; an identical
 * millisecond timestamp within one cluster is replay, not repetition.
 *
 * Occurrences with no timestamp are kept — absence of proof is not proof of a
 * replay, and dropping them would silently undercount older transcripts.
 */
export function dedupeReplayedOccurrences(candidates: Candidate[]): Candidate[] {
  return candidates.map(candidate => {
    if (candidate.occurrences.length < 2) return candidate;
    const seen = new Set<string>();
    const occurrences = candidate.occurrences.filter(occurrence => {
      if (!occurrence.ts) return true;
      if (seen.has(occurrence.ts)) return false;
      seen.add(occurrence.ts);
      return true;
    });
    if (occurrences.length === candidate.occurrences.length) return candidate;
    const sessionIds = [...new Set(occurrences.map(occurrence => occurrence.sessionId))];
    return {
      ...candidate,
      occurrences,
      count: occurrences.length,
      sessions: sessionIds.length,
      sessionIds,
    };
  });
}

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a), tb = trigrams(b);
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface Bucket {
  signature: string;
  examples: string[];
  count: number;
  sessions: Set<string>;
  assistants: Set<"claude-code" | "codex">;
  occurrences: { ts: string; sessionId: string }[];
  memberSignatures: string[];
}

export function cluster(
  turns: Turn[],
  opts: { minCount?: number; simThreshold?: number } = {},
): Candidate[] {
  const minCount = opts.minCount ?? 3;
  const simThreshold = opts.simThreshold ?? 0.6;

  // Stage 1: exact-normalized buckets.
  const exact = new Map<string, Bucket>();
  for (const t of turns) {
    if (t.role !== "user" || !t.text) continue;
    const norm = normalize(t.text);
    if (norm.length < 2) continue;
    let b = exact.get(norm);
    if (!b) {
      b = { signature: norm, examples: [], count: 0, sessions: new Set(), assistants: new Set(), occurrences: [], memberSignatures: [norm] };
      exact.set(norm, b);
    }
    b.count++;
    b.sessions.add(t.sessionId);
    b.assistants.add(t.assistant ?? "claude-code");
    b.occurrences.push({ ts: t.ts, sessionId: t.sessionId });
    if (b.examples.length < 5) b.examples.push(t.text);
  }

  // Stage 2: merge near-duplicate buckets, comparing only LSH-band-sharing hosts.
  const buckets = [...exact.values()].sort((a, b) => b.count - a.count);
  const merged: Bucket[] = [];
  const fuzzyMember: boolean[] = [];
  const bandIndex = new Map<string, number[]>(); // bandKey -> host indices

  for (const b of buckets) {
    const keys = bandKeys(minhash(trigrams(b.signature)));
    const candidateHosts = new Set<number>();
    for (const k of keys) for (const hi of bandIndex.get(k) ?? []) candidateHosts.add(hi);

    let hostIdx = -1;
    for (const hi of [...candidateHosts].sort((x, y) => x - y)) {
      if (similarity(merged[hi].signature, b.signature) >= simThreshold) { hostIdx = hi; break; }
    }

    if (hostIdx >= 0) {
      const host = merged[hostIdx];
      host.count += b.count;
      for (const s of b.sessions) host.sessions.add(s);
      for (const assistant of b.assistants) host.assistants.add(assistant);
      host.occurrences.push(...b.occurrences);
      host.memberSignatures.push(...b.memberSignatures);
      for (const ex of b.examples) if (host.examples.length < 5) host.examples.push(ex);
      fuzzyMember[hostIdx] = true;
    } else {
      merged.push({ ...b, sessions: new Set(b.sessions), assistants: new Set(b.assistants), occurrences: [...b.occurrences], memberSignatures: [...b.memberSignatures] });
      const idx = merged.length - 1;
      fuzzyMember[idx] = false;
      for (const k of keys) {
        const arr = bandIndex.get(k) ?? [];
        arr.push(idx);
        bandIndex.set(k, arr);
      }
    }
  }

  const candidates: Candidate[] = [];
  merged.forEach((b, i) => {
    if (b.count < minCount) return;
    const confidence: Confidence = fuzzyMember[i] ? "inferred" : "high";
    candidates.push({
      kind: "unknown",
      signature: b.signature,
      examples: b.examples,
      count: b.count,
      sessions: b.sessions.size,
      sessionIds: [...b.sessions],
      occurrences: b.occurrences,
      memberSignatures: b.memberSignatures,
      confidence,
      assistants: [...b.assistants],
    });
  });
  return candidates.sort((a, b) => b.count - a.count);
}
