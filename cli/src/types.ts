// Data model for the gradient analysis engine.
// Mirrors docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md §4.

export type Confidence = "high" | "inferred" | "flagged";
export type ArtifactKind = "command" | "loop" | "hook";

/** One genuine history event after parse + filter (injected text already removed). */
export type Turn = {
  ts: string; // ISO timestamp
  project: string; // last path segment of cwd
  branch?: string; // gitBranch if present
  role: "user" | "assistant";
  source: string; // transcript file the turn came from (for session counting)
  text?: string; // typed prompt (user)
  toolUses?: string[]; // tool names invoked (assistant)
};

/** Pre-LLM grouping produced by cluster.ts — no model involved. */
export type Candidate = {
  kind: ArtifactKind | "unknown";
  signature: string; // normalized key the cluster grouped on
  examples: string[]; // a few representative raw prompts
  count: number; // frequency across history
  sessions: number; // distinct transcripts the pattern appears in
  confidence: Confidence; // exact repeat vs fuzzy vs weak
};

/** Post-LLM (or no-LLM for high-confidence), ready to present / emit. */
export type Suggestion = {
  id: string; // stable hash of signature
  type: ArtifactKind;
  name: string; // e.g. "ship"
  title: string; // human summary
  rationale: string; // why, with evidence
  evidence: { count: number; sessions: number };
  confidence: Confidence;
  artifact: CommandArtifact | LoopArtifact | HookArtifact;
};

/** A suggestion before its artifact is emitted (input to the emit/* modules). */
export type SuggestionDraft = Omit<Suggestion, "artifact">;

export type CommandArtifact = { kind: "command"; path: string; content: string };
export type LoopArtifact = { kind: "loop"; command: string };
export type HookArtifact = {
  kind: "hook";
  event: string;
  subcommand: string; // must be a real gradient subcommand (validate.ts gates this)
  settingsPatch: string;
};

/** Persisted record of a generated artifact — makes apply reversible. */
export type ManifestEntry = {
  name: string;
  type: ArtifactKind;
  path: string;
  createdAt: string;
  suggestionId: string;
};
