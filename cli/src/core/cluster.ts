import type { ArtifactKind, Candidate, Confidence, Turn } from "../types";

const LOOP_WORDS = [/^continue\b/i, /what'?s next/i, /keep going/i, /carry on/i];
const HOOK_HINTS = [/\bcompact\b/i, /checkpoint/i];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/g, "")
    .trim()
    .slice(0, 120);
}

function classify(sig: string): ArtifactKind | "unknown" {
  if (LOOP_WORDS.some((r) => r.test(sig))) return "loop";
  if (HOOK_HINTS.some((r) => r.test(sig))) return "hook";
  // Everything else that repeats is a slash-command candidate.
  return "command";
}

export type ClusterResult = { candidates: Candidate[]; dropped: number };

/**
 * Frequency + exact-normalized grouping. Pure — no LLM involved (spec decision #7).
 * Below `minCount` a pattern is dropped (and counted, never silently).
 */
export function cluster(
  prompts: Turn[],
  opts: { minCount?: number } = {},
): ClusterResult {
  const minCount = opts.minCount ?? 2;
  const groups = new Map<
    string,
    { examples: string[]; count: number; sessions: Set<string> }
  >();

  for (const t of prompts) {
    if (t.text === undefined) continue;
    const sig = normalize(t.text);
    if (!sig) continue;
    let g = groups.get(sig);
    if (!g) {
      g = { examples: [], count: 0, sessions: new Set() };
      groups.set(sig, g);
    }
    g.count++;
    g.sessions.add(t.source);
    if (g.examples.length < 3 && !g.examples.includes(t.text)) {
      g.examples.push(t.text);
    }
  }

  let dropped = 0;
  const candidates: Candidate[] = [];
  for (const [signature, g] of groups) {
    if (g.count < minCount) {
      dropped++;
      continue;
    }
    const confidence: Confidence =
      g.count >= 5 ? "high" : g.count >= 3 ? "inferred" : "flagged";
    candidates.push({
      kind: classify(signature),
      signature,
      examples: g.examples,
      count: g.count,
      sessions: g.sessions.size,
      confidence,
    });
  }

  candidates.sort((a, b) => b.count - a.count);
  return { candidates, dropped };
}
