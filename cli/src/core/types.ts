export type Role = "user" | "assistant";
export type Confidence = "high" | "inferred" | "flagged";
export type ArtifactType = "command" | "loop" | "hook";

/** One genuine user prompt after parse + filter. (v1 consumes only user text;
 * assistant turns / tool sequences are intentionally not parsed until phase 2.) */
export interface Turn {
  ts: string;
  project: string;
  branch?: string;
  role: Role;
  text?: string;        // typed prompt (user), injected text removed
  sessionId: string;
}

/** Pre-LLM grouping produced by cluster.ts (no model involved). */
export interface Candidate {
  kind: ArtifactType | "unknown";
  signature: string;     // normalized key the cluster grouped on
  examples: string[];    // representative raw prompts
  count: number;
  sessions: number;
  sessionIds: string[];  // distinct session ids (for exact union when clusters merge)
  confidence: Confidence;
}

/** Semantic content of a suggestion; emit/* formats it into an artifact. */
export type SuggestionPayload =
  | { type: "command"; commandName: string; body: string }
  | { type: "loop"; instruction: string; cadence?: string }
  | { type: "hook"; event: string; subcommand: string; description: string };

/** Post-LLM (or post-degradation), ready to present/emit. */
export interface Suggestion {
  id: string;
  name: string;
  title: string;
  rationale: string;
  evidence: { count: number; sessions: number };
  confidence: Confidence;
  examples?: string[];   // representative redacted prompts, for `explain`
  payload: SuggestionPayload;
}

export interface ManifestEntry {
  name: string;
  type: ArtifactType;
  path: string;          // written file path; "" for loop (printed only)
  createdAt: string;
  suggestionId: string;
}

export interface Config {
  backend?: "claude-cli" | "anthropic";
  model?: string;
  /** Default recency window (days) for `scan --user`. Defaults to 7. */
  userScopeDays?: number;
  /** Max prompts fed into clustering before older ones are dropped. Defaults to 1500. */
  maxPrompts?: number;
}
