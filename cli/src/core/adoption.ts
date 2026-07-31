import type { ArtifactType, CommandEvent, Suggestion } from "./types.js";
import { loadManifest } from "./manifest.js";
import { countArtifactUses } from "./usage.js";
import { perOccurrenceSeconds, type LeverageKind } from "./leverage.js";

export interface AdoptionRow {
  name: string;
  type: ArtifactType;
  createdAt: string;
  uses: number;
  lastUsed?: string;
  /** Realized minutes saved so far: uses × per-occurrence estimate (leverage
   * constants). 0 when there are no uses yet or no chars could be recovered —
   * callers should treat 0 as "nothing to report", not print it. */
  realizedMinutesSaved: number;
  suggestRemoval: boolean;
}

export const UNUSED_REMOVAL_DAYS = 30;
const DAY_MS = 86_400_000;

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
  const suggestionsById = new Map((opts.suggestions ?? []).map(suggestion => [suggestion.id, suggestion]));
  const suggestionsByName = new Map((opts.suggestions ?? []).map(suggestion => [suggestion.name, suggestion]));
  const now = opts.now ?? Date.now();
  return [...logical.values()].map(entry => {
    const usage = uses.get(entry.name) ?? { uses: 0, lastUsed: undefined };
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
      realizedMinutesSaved,
      suggestRemoval: usage.uses === 0 && Number.isFinite(age) && age >= UNUSED_REMOVAL_DAYS * DAY_MS,
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
