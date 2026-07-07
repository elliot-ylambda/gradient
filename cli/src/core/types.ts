export type Role = "user" | "assistant";
export type Confidence = "high" | "inferred" | "flagged";
export type ArtifactType = "command" | "loop" | "hook";

/** One genuine user prompt after parse + filter. (The mining pipeline consumes
 * only user text; assistant turns are rendered by core/tail.ts for autopilot.) */
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
  /** When true, a SessionStart hook runs `gradient scan --detach`. */
  scanOnSessionStart?: boolean;
  /** Auto-responder mode. Absent = off. Mode is user-global; the Stop hook is per-project. */
  autopilot?: AutopilotMode;
  /** Max auto-responses per session. Defaults to 10. */
  autopilotBudget?: number;
  /** Judge model (fast by design; the judge sits in the user's stop path). Defaults to "haiku". */
  autopilotModel?: string;
  /** Extra regexes (source strings) classified as machine-injected during mining. */
  ignorePatterns?: string[];
}

/** Autopilot authority ladder (spec §2 #1). */
export type AutopilotMode = "off" | "nudge" | "full";

/** One autopilot decision, kept for `gradient autopilot status`. */
export interface AutopilotLogEntry {
  ts: string;
  action: "continue" | "stand_down";
  why: string;
  excerpt: string;
}

/** Per-session autopilot state (~/.config/gradient/state/<session_id>.json). */
export interface SessionState {
  count: number;           // auto-responses sent this session
  lastFingerprint: string; // tool-activity fingerprint at our last decision
  stoodDown: boolean;      // latched when a nudge produced no progress
  log: AutopilotLogEntry[];
}
