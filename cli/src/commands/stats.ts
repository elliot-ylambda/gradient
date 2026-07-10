import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactType, Confidence, Turn } from "../core/types.js";
import { gradientDir, loadManifest } from "../core/manifest.js";
import { loadSuggestions } from "./apply.js";
import { loadConfig } from "../config.js";
import { collect } from "../core/collect.js";
import { parseFile } from "../core/parse.js";
import { countArtifactUses } from "../core/usage.js";

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
  sessionScanEnabled: boolean;
  patterns: StatPattern[];
  adoption: AdoptionRow[];
}

export interface AdoptionRow {
  name: string;
  type: ArtifactType;
  createdAt: string;
  uses: number;
  lastUsed?: string;
  retypesCaught: number;
  suggestRemoval: boolean;
}

export const UNUSED_REMOVAL_DAYS = 30;
const DAY_MS = 86_400_000;

export interface StatsOptions {
  home?: string;
  now?: number;
  collectFn?: typeof collect;
  parseFn?: typeof parseFile;
}

export async function adoptionFromTurns(
  projectDir: string,
  turns: Turn[],
  opts: { now?: number; manifest?: Awaited<ReturnType<typeof loadManifest>> } = {},
): Promise<AdoptionRow[]> {
  const manifest = opts.manifest ?? (await loadManifest(projectDir));
  const since = new Map(manifest.map(entry => [entry.name, entry.createdAt]));
  const uses = countArtifactUses(turns, since);
  const retypes = await readRetypes(projectDir, since);
  const now = opts.now ?? Date.now();
  return manifest.map(entry => {
    const usage = uses.get(entry.name) ?? { uses: 0, lastUsed: undefined };
    const retypesCaught = retypes.get(entry.name) ?? 0;
    const age = now - Date.parse(entry.createdAt);
    return {
      name: entry.name,
      type: entry.type,
      createdAt: entry.createdAt,
      uses: usage.uses,
      lastUsed: usage.lastUsed,
      retypesCaught,
      suggestRemoval: (
        usage.uses === 0 &&
        retypesCaught === 0 &&
        Number.isFinite(age) &&
        age >= UNUSED_REMOVAL_DAYS * DAY_MS
      ),
    };
  });
}

async function readRetypes(
  projectDir: string,
  since: Map<string, string>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const raw = await readFile(join(gradientDir(projectDir), "adoption.jsonl"), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { ts?: unknown; artifact?: unknown; hinted?: unknown };
        if (event.hinted !== true || typeof event.artifact !== "string" || !since.has(event.artifact)) continue;
        if (typeof event.ts !== "string") continue;
        const eventTime = Date.parse(event.ts);
        const created = Date.parse(since.get(event.artifact)!);
        if (!Number.isFinite(eventTime) || (Number.isFinite(created) && eventTime < created)) continue;
        counts.set(event.artifact, (counts.get(event.artifact) ?? 0) + 1);
      } catch {
        // A malformed append-only line must not hide the remaining events.
      }
    }
  } catch {
    // No adoption log yet.
  }
  return counts;
}

export async function stats(projectDir: string, opts: StatsOptions = {}): Promise<StatsReport> {
  const suggestions = await loadSuggestions(projectDir);
  const manifest = await loadManifest(projectDir);
  const coveredIds = new Set(manifest.map(m => m.suggestionId));
  const config = await loadConfig(opts.home);

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

  const turns: Turn[] = [];
  if (manifest.length > 0) {
    const collectFn = opts.collectFn ?? collect;
    const parseFn = opts.parseFn ?? parseFile;
    const files = await collectFn({ scope: "project", projectPath: projectDir, home: opts.home });
    for (const file of files) turns.push(...(await parseFn(file)));
  }

  const adoption = await adoptionFromTurns(projectDir, turns, { now: opts.now, manifest });

  return {
    total,
    covered,
    coveragePct,
    sessionScanEnabled: config.scanOnSessionStart === true,
    patterns,
    adoption,
  };
}
