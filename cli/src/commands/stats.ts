import type { ArtifactType, CommandEvent, Confidence, Suggestion } from "../core/types.js";
import { loadManifest } from "../core/manifest.js";
import { loadSuggestions } from "./apply.js";
import { loadConfig, resolveTargets } from "../config.js";
import { collect } from "../core/collect.js";
import { collectCodex } from "../core/collect-codex.js";
import { parseTranscriptFile } from "../core/parse.js";
import { parseCodexFile } from "../core/parse-codex.js";
import { countArtifactUses } from "../core/usage.js";
import { adoptionPath } from "./recall.js";
import { safeReadFile } from "../core/safeFs.js";
import { homedir } from "node:os";
import { perOccurrenceSeconds, type LeverageKind } from "../core/leverage.js";

const ADOPTION_LOG_MAX_BYTES = 5_000_000;

export interface StatPattern {
  name: string;
  count: number;
  sessions: number;
  confidence: Confidence;
  covered: boolean;
  estMinutesSavedPerMonth?: number;
}

export interface StatsReport {
  total: number;
  covered: number;
  coveragePct: number;
  sessionScanEnabled: boolean;
  patterns: StatPattern[];
  adoption: AdoptionRow[];
  capped: boolean;
}

export interface AdoptionRow {
  name: string;
  type: ArtifactType;
  createdAt: string;
  uses: number;
  lastUsed?: string;
  retypesCaught: number;
  realizedMinutesSaved: number;
  suggestRemoval: boolean;
}

export const UNUSED_REMOVAL_DAYS = 30;
const DAY_MS = 86_400_000;

export interface StatsOptions {
  home?: string;
  now?: number;
  collectFn?: typeof collect;
  collectCodexFn?: typeof collectCodex;
  parseFn?: typeof parseTranscriptFile;
  parseCodexFn?: typeof parseCodexFile;
  onSkip?: (message: string) => void;
  /** Test/embedding overrides can only lower the hard resource ceilings. */
  maxFiles?: number;
  maxTurns?: number;
}

export const STATS_MAX_FILES = 2_000;
export const STATS_MAX_TURNS = 100_000;

export async function adoptionFromEvents(
  projectDir: string,
  events: CommandEvent[],
  opts: {
    home?: string;
    now?: number;
    manifest?: Awaited<ReturnType<typeof loadManifest>>;
    suggestions?: Suggestion[];
  } = {},
): Promise<AdoptionRow[]> {
  const manifest = opts.manifest ?? (await loadManifest(projectDir));
  const logical = new Map<string, (typeof manifest)[number]>();
  for (const entry of manifest) {
    const prior = logical.get(entry.name);
    if (!prior || entry.createdAt < prior.createdAt) logical.set(entry.name, entry);
  }
  const since = new Map([...logical.values()].map(entry => [entry.name, entry.createdAt]));
  const uses = countArtifactUses(events, since);
  const retypes = await readRetypes(projectDir, since, opts.home);
  const suggestionsById = new Map((opts.suggestions ?? []).map(suggestion => [suggestion.id, suggestion]));
  const suggestionsByName = new Map((opts.suggestions ?? []).map(suggestion => [suggestion.name, suggestion]));
  const now = opts.now ?? Date.now();
  return [...logical.values()].map(entry => {
    const usage = uses.get(entry.name) ?? { uses: 0, lastUsed: undefined };
    const retypesCaught = retypes.get(entry.name) ?? 0;
    const suggestion = suggestionsById.get(entry.suggestionId) ?? suggestionsByName.get(entry.name);
    const realizedMinutesSaved = Math.round(
      usage.uses * perOccurrenceSeconds({
        chars: suggestionChars(suggestion),
        kind: artifactLeverageKind(entry.type, suggestion),
      }) / 60,
    );
    const age = now - Date.parse(entry.createdAt);
    return {
      name: entry.name,
      type: entry.type,
      createdAt: entry.createdAt,
      uses: usage.uses,
      lastUsed: usage.lastUsed,
      retypesCaught,
      realizedMinutesSaved,
      suggestRemoval: (
        usage.uses === 0 &&
        retypesCaught === 0 &&
        Number.isFinite(age) &&
        age >= UNUSED_REMOVAL_DAYS * DAY_MS
      ),
    };
  });
}

function artifactLeverageKind(type: ArtifactType, suggestion: Suggestion | undefined): LeverageKind {
  if (suggestion?.payload.type === "project-playbook") {
    return suggestion.payload.section === "rules" ? "rule" : "command";
  }
  if (suggestion) return suggestion.payload.type;
  if (type === "loop" || type === "hook" || type === "rule") return type;
  return "command";
}

function suggestionChars(suggestion: Suggestion | undefined): number {
  if (!suggestion) return 0;
  const values = suggestion.payload.type === "command" && suggestion.payload.triggers?.length
    ? suggestion.payload.triggers
    : suggestion.examples ?? [];
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value.length, 0) / values.length;
}

async function readRetypes(
  projectDir: string,
  since: Map<string, string>,
  home?: string,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const userHome = home ?? homedir();
    const raw = await safeReadFile(
      userHome,
      adoptionPath(projectDir, userHome),
      { maxBytes: ADOPTION_LOG_MAX_BYTES },
    );
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
  const suggestions = await loadSuggestions(projectDir, opts);
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
      ...(s.evidence.estMinutesSavedPerMonth !== undefined
        ? { estMinutesSavedPerMonth: s.evidence.estMinutesSavedPerMonth }
        : {}),
    }))
    .sort((a, b) =>
      (b.estMinutesSavedPerMonth ?? 0) - (a.estMinutesSavedPerMonth ?? 0) ||
      b.count - a.count ||
      a.name.localeCompare(b.name));

  const total = patterns.length;
  const covered = patterns.filter(p => p.covered).length;
  const coveragePct = total === 0 ? 0 : Math.round((covered / total) * 100);

  const events: CommandEvent[] = [];
  let capped = false;
  if (manifest.length > 0) {
    const targets = resolveTargets(config);
    const collectFn = opts.collectFn ?? collect;
    const collectCodexFn = opts.collectCodexFn ?? collectCodex;
    const parseFn = opts.parseFn ?? parseTranscriptFile;
    const parseCodexFn = opts.parseCodexFn ?? parseCodexFile;
    const collectOptions = { scope: "project" as const, projectPath: projectDir, home: opts.home };
    const claudeFiles = targets.includes("claude-code") ? await collectFn(collectOptions) : [];
    const codexFiles = targets.includes("codex") ? await collectCodexFn(collectOptions) : [];
    const files: Array<{ path: string; assistant: "claude-code" | "codex" }> = [];
    for (let index = 0; index < claudeFiles.length || index < codexFiles.length; index++) {
      if (index < claudeFiles.length) files.push({ path: claudeFiles[index], assistant: "claude-code" });
      if (index < codexFiles.length) files.push({ path: codexFiles[index], assistant: "codex" });
    }
    const maxFiles = Math.max(1, Math.min(opts.maxFiles ?? STATS_MAX_FILES, STATS_MAX_FILES));
    const maxTurns = Math.max(1, Math.min(opts.maxTurns ?? STATS_MAX_TURNS, STATS_MAX_TURNS));
    if (files.length > maxFiles) capped = true;
    let processed = 0;
    for (const file of files.slice(0, maxFiles)) {
      if (processed >= maxTurns) { capped = true; break; }
      const remaining = maxTurns - processed;
      if (file.assistant === "codex") {
        // Codex parsing is untouched — its transcripts carry no command-tag
        // events — but its turn volume still counts against the resource cap.
        const turnCount = (await parseCodexFn(file.path)).length;
        if (turnCount > remaining) capped = true;
        processed += Math.min(turnCount, remaining);
        continue;
      }
      const parsed = await parseFn(file.path);
      // Events share the turn ceiling: a transcript that is all slash commands
      // must not bypass the resource cap by contributing zero turns.
      const eventBudget = Math.max(0, remaining - parsed.turns.length);
      if (parsed.turns.length > remaining || parsed.events.length > eventBudget) capped = true;
      processed += Math.min(parsed.turns.length + parsed.events.length, remaining);
      events.push(...parsed.events.slice(0, eventBudget));
    }
  }

  const adoption = await adoptionFromEvents(projectDir, events, {
    home: opts.home,
    now: opts.now,
    manifest,
    suggestions,
  });

  return {
    total,
    covered,
    coveragePct,
    sessionScanEnabled: config.scanOnSessionStart === true,
    patterns,
    adoption,
    capped,
  };
}
