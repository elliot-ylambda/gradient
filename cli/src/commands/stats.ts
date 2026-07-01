import type { Confidence } from "../core/types.js";
import { loadManifest } from "../core/manifest.js";
import { loadSuggestions } from "./apply.js";

export interface StatPattern {
  name: string;
  count: number;
  sessions: number;
  confidence: Confidence;
  covered: boolean;
}

export interface StatsReport {
  total: number;
  covered: number;
  coveragePct: number;
  patterns: StatPattern[];
}

export async function stats(projectDir: string): Promise<StatsReport> {
  const suggestions = await loadSuggestions(projectDir);
  const manifest = await loadManifest(projectDir);
  const coveredIds = new Set(manifest.map(m => m.suggestionId));

  const patterns: StatPattern[] = suggestions
    .map(s => ({
      name: s.name,
      count: s.evidence.count,
      sessions: s.evidence.sessions,
      confidence: s.confidence,
      covered: coveredIds.has(s.id),
    }))
    .sort((a, b) => b.count - a.count);

  const total = patterns.length;
  const covered = patterns.filter(p => p.covered).length;
  const coveragePct = total === 0 ? 0 : Math.round((covered / total) * 100);
  return { total, covered, coveragePct, patterns };
}
