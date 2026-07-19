export type Role = "user" | "assistant";
export type Confidence = "high" | "inferred" | "flagged";
export type ArtifactType = "command" | "loop" | "hook" | "skill" | "rule" | "playbook-entry";
export type Assistant = "claude-code" | "codex";

/** One complete reading of an ambiguous pattern. */
export interface ClarifyOption {
  label: string;
  body: string;
}

/** Judge-authored disambiguation for a flagged suggestion. `chosen` is set
 * only after the user resolves it during review. */
export interface Clarify {
  question: string;
  options: ClarifyOption[];
  chosen?: string;
}

/** Local-only temporal evidence per cluster (core/temporal.ts). */
export interface TemporalFeatures {
  maxRunLength: number;      // longest streak of consecutive user prompts in one session, all in this cluster
  runSessions: number;       // sessions containing a run of length ≥ 2
  medianGapMinutes: number;  // median gap between successive occurrences
  distinctDays: number;
  spanDays: number;
}

/** A slash-command invocation extracted from a `<command-name>` turn at parse
 * time (core/parse.ts). Structured replacement for ad-hoc regex scraping in
 * usage.ts (adoption counting) and insights.ts (compact/model-switch metrics);
 * never enters clustering. */
export interface CommandEvent {
  ts: string;
  sessionId: string;
  project: string;
  command: string;
}

/** One genuine user prompt after parse + filter. (The mining pipeline consumes
 * only user text; tool and command activity is mined separately; assistant
 * turns are rendered by core/tail.ts for autopilot.) */
export interface Turn {
  ts: string;
  project: string;
  branch?: string;
  role: Role;
  text?: string;        // typed prompt (user), injected text removed
  sessionId: string;
  /** Source assistant; absent means Claude Code for pre-multi-assistant fixtures. */
  assistant?: Assistant;
  /** Tokens consumed by the model turn this prompt initiated, when recorded. */
  usageTokens?: number;
}

/** One tool invocation mined from a transcript. Only Bash and file-edit tools
 * are extracted; outputs never exceed a redacted, bounded error head. */
export interface ToolEvent {
  ts: string;
  sessionId: string;
  kind: "bash" | "edit";
  command?: string;
  isError?: boolean;
  errorHead?: string;
  file?: string;
}

/** Pre-LLM grouping produced by cluster.ts (no model involved). */
export interface Candidate {
  kind: ArtifactType | "unknown" | "paste" | "answer" | "sequence" | "correction" | "toolfail" | "ritual" | "instruction";
  signature: string;     // normalized key the cluster grouped on
  examples: string[];    // representative raw prompts
  count: number;
  sessions: number;
  sessionIds: string[];  // distinct session ids (for exact union when clusters merge)
  /** One entry per occurrence; unioned when clusters merge (bucket order after a
   * fuzzy merge, not chronological — consumers re-sort by timestamp). */
  occurrences: { ts: string; sessionId: string }[];
  /** Host signature plus every absorbed near-duplicate signature (for turn→cluster
   * membership). Non-cluster producers (paste/answer/sequence) leave it empty. */
  memberSignatures: string[];
  confidence: Confidence;
  assistants?: Assistant[];
  /** Redacted routing context for specialized detect candidates. */
  hint?: string;
  temporal?: TemporalFeatures;
  /** Set by classify.ts's markLoops when temporal.distinctDays crosses the
   * daily-coverage floor; a deterministic UTC cron expression. */
  cadence?: string;
}

/** Semantic content of a suggestion; emit/* formats it into an artifact. */
export type SuggestionPayload =
  | { type: "command"; commandName: string; body: string; triggers?: string[]; mechanical?: boolean }
  | { type: "loop"; instruction: string; cadence?: string }
  | { type: "hook"; event: string; description: string; matcher?: string; subcommand?: string; command?: string }
  | { type: "rule"; target: "project" | "user"; ruleName: string; text: string }
  | { type: "project-playbook"; section: "rules" | "workflows"; text: string };

/** Post-LLM (or post-degradation), ready to present/emit. */
export interface Suggestion {
  id: string;
  name: string;
  title: string;
  rationale: string;
  evidence: {
    count: number;
    sessions: number;
    assistants?: Assistant[];
    /** Optional: absent on pre-existing caches/fixtures written before this field existed. */
    estMinutesSavedPerMonth?: number;
    /** Optional: temporal evidence of the highest-count source candidate, when annotated. */
    temporal?: TemporalFeatures;
  };
  confidence: Confidence;
  clarify?: Clarify;
  examples?: string[];   // representative redacted prompts, for `explain`
  /** Redacted union of source candidates' memberSignatures (fallback [signature] when
   * empty). Optional: absent on pre-existing caches/fixtures written before this field
   * existed. Stable across corpus growth — the basis for this suggestion's id. */
  sourceSignatures?: string[];
  payload: SuggestionPayload;
}

export interface ManifestEntry {
  name: string;
  type: ArtifactType;
  path: string;          // written file path; "" for loop (printed only)
  createdAt: string;
  suggestionId: string;
  /** Absent means claude-code for manifests written before multi-assistant support. */
  target?: Assistant;
  /** Installed hook artifacts record what to un-merge from settings on removal. */
  hook?: { event: string; matcher?: string; command: string };
}

export interface Config {
  backend?: "claude-cli" | "codex-cli" | "anthropic";
  model?: string;
  /** Model used by the Codex CLI backend; absent uses the Codex default. */
  codexModel?: string;
  /** Default recency window (days) for `scan --user`. Defaults to 7. */
  userScopeDays?: number;
  /** Max prompts fed into clustering before older ones are dropped. Defaults to 1500. */
  maxPrompts?: number;
  /** When true, SessionStart surfaces one cached suggestion and starts a detached scan. */
  scanOnSessionStart?: boolean;
  /** Legacy global mode. Ignored by 0.1.1+; users must re-consent per project. */
  autopilot?: AutopilotMode;
  /** Canonical project path -> locally consented mode. */
  autopilotProjects?: Record<string, AutopilotMode>;
  /** Canonical project paths where recall is locally consented. */
  recallProjects?: string[];
  /** Canonical project paths where checkpoint/recap hooks are locally consented. */
  continuityProjects?: string[];
  /** Canonical board-root paths (git common-dir roots) where cross-session board hooks are consented. */
  boardProjects?: string[];
  /** Max paid judge attempts per session. Defaults to 10. */
  autopilotBudget?: number;
  /** Judge model (fast by design; the judge sits in the user's stop path). Defaults to "haiku". */
  autopilotModel?: string;
  /** Extra regexes (source strings) classified as machine-injected during mining. */
  ignorePatterns?: string[];
  /** Artifact format for command-type suggestions. Default "skill". */
  emitTarget?: "skill" | "command";
  /** Assistants that receive approved skills. Defaults to ["claude-code"]. */
  targets?: Assistant[];
  /** Claude model frontmatter for mechanical skills. Empty disables it. Default "haiku". */
  cheapSkillModel?: string;
  /** Mine tool events for failure loops and post-edit rituals. Absent = on. */
  mineToolEvents?: boolean;
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
  attempts: number;        // paid judge calls attempted this session
  lastFingerprint: string; // tool-activity fingerprint at our last decision
  stoodDown: boolean;      // latched when a nudge produced no progress
  log: AutopilotLogEntry[];
}
