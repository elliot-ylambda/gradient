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

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a), tb = trigrams(b);
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

interface Bucket { signature: string; examples: string[]; count: number; sessions: Set<string> }

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
    if (!b) { b = { signature: norm, examples: [], count: 0, sessions: new Set() }; exact.set(norm, b); }
    b.count++;
    b.sessions.add(t.sessionId);
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
      for (const ex of b.examples) if (host.examples.length < 5) host.examples.push(ex);
      fuzzyMember[hostIdx] = true;
    } else {
      merged.push({ ...b, sessions: new Set(b.sessions) });
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
      confidence,
    });
  });
  return candidates.sort((a, b) => b.count - a.count);
}
