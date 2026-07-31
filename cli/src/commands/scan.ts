import { homedir } from "node:os";
import type { Candidate, CommandEvent, Config, Suggestion, ToolEvent, Turn } from "../core/types.js";
import { collect } from "../core/collect.js";
import { collectCodex } from "../core/collect-codex.js";
import {
  parseDialogueFile,
  parseAssistantFollowedUserFile,
  parseToolEventsFile,
  parseTranscriptFile,
  type DialogueTurn,
  type ParsedTranscript,
} from "../core/parse.js";
import {
  parseCodexDialogueFile,
  parseCodexFile,
  parseCodexSessionFile,
} from "../core/parse-codex.js";
import { compileIgnorePatterns, filterPrompts, hasTemplateFloodSupport, isTemplateFlood } from "../core/filter.js";
import { boundedPromptLimit, capByRecency, MAX_PROMPTS_HARD_CAP } from "../core/cap.js";
import { DEFAULT_DETECT_WINDOW, DEFAULT_MAX_PROMPTS } from "../core/scope.js";
import { cluster, normalize } from "../core/cluster.js";
import { activeWindows, annotateTemporal } from "../core/temporal.js";
import { isRestatement } from "../core/restatement.js";
import { commandEventIdentity, dedupeReplayedEvents, toolEventIdentity, turnIdentity } from "../core/replay.js";
import { hookFromEvents, markLoops } from "../core/classify.js";
import { markCorrections } from "../core/corrections.js";
import { mineSequences, SEQ_MAX_BIGRAMS } from "../core/sequence.js";
import { boundedDetectLimit, detect } from "../core/detect.js";
import { validateSuggestion } from "../core/validate.js";
import { findHusks, findMissingSessions } from "../core/coverage.js";
import { selectBackend } from "../llm/index.js";
import { loadConfig, resolveTargets } from "../config.js";
import type { LLMBackend } from "../llm/backend.js";
import { saveSuggestions } from "./apply.js";
import { detectPasteCandidates, extractPasteKey } from "../core/paste.js";
import { ANSWER_MAX_PAIRS, extractAnswerPairs, mineAnswerCandidates } from "../core/answers.js";
import { attentionSuggestion, mineAttention } from "../core/attention.js";
import { isNudgeText } from "../core/insights.js";

import { mineProjectPlaybook } from "../core/project-suggest.js";
import { failureLoops, rituals } from "../core/toolmine.js";
import { loadInstructions } from "../core/instructions.js";
import { audit, clearInstructionAudit, CORRECTION_RE, saveInstructionAudit } from "../core/audit.js";

/**
 * Candidate kinds produced by clustering raw prompt text, and only those.
 *
 * This is the family where a single sitting masquerades as a habit: forked
 * sessions replay a parent's prompts, and iterating on one hard feature repeats
 * the same phrasing all afternoon. Every other producer already carries its own
 * support floor — pastes need PASTE_MIN_COUNT, sequences need recurrence,
 * tool-event kinds are counted facts — so gating them would suppress real
 * signal without removing any of the noise actually observed.
 */
const CLUSTERED_PROMPT_KINDS: ReadonlySet<string> = new Set(["unknown", "loop", "correction"]);
const MIN_ACTIVE_WINDOWS = 2;

const MAX_MINED_PROMPT_CHARS = 4_000;
export const MAX_TOOL_EVENTS = 20_000;

export interface ScanOptions {
  scope: "project" | "all";
  projectPath?: string;
  sinceDays?: number;
  limit?: number;
  maxPrompts?: number;
  home?: string;
  now?: number;
}

export interface ScanDeps {
  backend?: LLMBackend | null;
  config?: Config;
  collectFn?: (options: ScanOptions) => Promise<string[]>;
  collectCodexFn?: (options: ScanOptions) => Promise<string[]>;
  parseFn?: (path: string) => Promise<ParsedTranscript | Turn[]>;
  parseToolEventsFn?: (path: string) => Promise<{ events: ToolEvent[]; dropped: number }>;
  parseCorrectionContextFn?: (path: string) => Promise<Turn[]>;
  parseCodexFn?: (path: string) => Promise<Turn[]>;
  parseDialogueFn?: (path: string) => Promise<DialogueTurn[]>;
  parseCodexDialogueFn?: (path: string) => Promise<DialogueTurn[]>;
  attentionFn?: typeof mineAttention;
  gitLogFn?: (dir: string, sinceDays: number) => Promise<string>;
  log?: (message: string) => void;
}

export async function scan(opts: ScanOptions, deps: ScanDeps = {}): Promise<Suggestion[]> {
  const log = deps.log ?? (() => {});
  const config = deps.config ?? (await loadConfig(opts.home));
  const targets = resolveTargets(config);
  const requestedMax = opts.maxPrompts ?? config.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  const max = boundedPromptLimit(requestedMax);
  if (max !== requestedMax) log(`max-prompts safety-capped to ${max}`);
  const requestedWindow = opts.limit ?? DEFAULT_DETECT_WINDOW;
  const window = boundedDetectLimit(requestedWindow, DEFAULT_DETECT_WINDOW);
  if (window !== requestedWindow) log(`candidate limit safety-capped to ${window}`);

  const collectFn = deps.collectFn ?? ((options: ScanOptions) => collect({ ...options, onWarn: log }));
  const collectCodexFn = deps.collectCodexFn ?? ((options: ScanOptions) => collectCodex({ ...options, onWarn: log }));
  const parseFn = deps.parseFn ?? parseTranscriptFile;
  const projectDir = opts.projectPath ?? process.cwd();
  const claudeFiles = targets.includes("claude-code") ? await collectFn(opts) : [];
  const codexFiles = targets.includes("codex") ? await collectCodexFn(opts) : [];
  const files = [...claudeFiles, ...codexFiles];
  log(targets.includes("codex")
    ? `files: ${files.length} transcripts (Claude Code ${claudeFiles.length} · Codex ${codexFiles.length})`
    : `files: ${files.length} transcripts`);

  const cutoff = opts.sinceDays === undefined
    ? undefined
    : (opts.now ?? Date.now()) - opts.sinceDays * 86_400_000;
  const scoped = <T extends { ts: string }>(items: T[]): T[] => cutoff === undefined
    ? items
    : items.filter(item => {
      const timestamp = Date.parse(item.ts);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
  const pushTurns = (current: Turn[], additions: Turn[]): Turn[] => {
    current.push(...scoped(additions));
    return current.length > MAX_PROMPTS_HARD_CAP
      ? capByRecency(current, MAX_PROMPTS_HARD_CAP).kept
      : current;
  };
  // Mirrors pushTurns' bound: command events are tiny per-record but still
  // an unbounded-history accumulator without a ceiling.
  const pushEvents = (current: CommandEvent[], additions: CommandEvent[]): CommandEvent[] => {
    current.push(...scoped(additions));
    return capByRecency(current, MAX_PROMPTS_HARD_CAP).kept;
  };

  const ignore = compileIgnorePatterns(config.ignorePatterns);
  const answerPairs = [] as ReturnType<typeof extractAnswerPairs>;
  const pairCap = Math.min(ANSWER_MAX_PAIRS, max);
  const instructions = opts.scope === "project"
    ? await loadInstructions(projectDir, opts.home ?? homedir())
    : [];
  if (opts.scope === "project" && instructions.length === 0) {
    await clearInstructionAudit(projectDir, opts.home);
  }
  let turns: Turn[] = [];
  let toolEvents: ToolEvent[] = [];
  let toolEventsDropped = 0;
  let confirmedCorrections: Turn[] = [];
  // Command events stay separate from minable prompt text and feed adoption,
  // insights, and deterministic checkpoint-hook detection.
  let events: CommandEvent[] = [];
  const parseToolEventsFn = deps.parseToolEventsFn ?? (deps.parseFn ? undefined : parseToolEventsFile);
  const parseCorrectionContextFn = deps.parseCorrectionContextFn ??
    (deps.parseFn ? undefined : parseAssistantFollowedUserFile);
  const userTurnCounts = new Map<string, number>();
  for (const file of claudeFiles) {
    const parsedValue = await parseFn(file);
    const parsed: ParsedTranscript = Array.isArray(parsedValue)
      ? { turns: parsedValue, events: [] }
      : parsedValue;
    userTurnCounts.set(file, parsed.turns.length + parsed.events.length);
    turns = pushTurns(turns, parsed.turns);
    events = pushEvents(events, parsed.events);
    if (config.mineToolEvents !== false && parseToolEventsFn) {
      const parsedEvents = await parseToolEventsFn(file);
      toolEventsDropped += parsedEvents.dropped;
      toolEvents.push(...scoped(parsedEvents.events));
      if (toolEvents.length > MAX_TOOL_EVENTS) {
        const capped = capByRecency(toolEvents, MAX_TOOL_EVENTS, MAX_TOOL_EVENTS);
        toolEventsDropped += capped.dropped;
        toolEvents = capped.kept;
      }
    }
    if (instructions.length > 0 && parseCorrectionContextFn) {
      confirmedCorrections.push(...scoped(await parseCorrectionContextFn(file)));
      if (confirmedCorrections.length > MAX_PROMPTS_HARD_CAP) {
        confirmedCorrections = capByRecency(confirmedCorrections, MAX_PROMPTS_HARD_CAP).kept;
      }
    }
  }

  // Before anything counts. Every cross-session floor downstream — two sessions
  // for a failure loop, three for a compaction hook — is otherwise satisfied by
  // a resumed session replaying its parent's history rather than by the thing
  // happening twice.
  const dedupedCommands = dedupeReplayedEvents(events, commandEventIdentity);
  const dedupedTools = dedupeReplayedEvents(toolEvents, toolEventIdentity);
  events = dedupedCommands.kept;
  toolEvents = dedupedTools.kept;
  const replayed = dedupedCommands.dropped + dedupedTools.dropped;
  if (replayed > 0) {
    log(`replay dedupe → ${replayed} event(s) inherited by resumed sessions counted once`);
  }

  const productionCodexSinglePass = !deps.parseCodexFn && !deps.parseCodexDialogueFn;
  for (const file of codexFiles) {
    if (productionCodexSinglePass) {
      const parsed = await parseCodexSessionFile(file);
      turns = pushTurns(turns, parsed.turns);
      if (opts.scope === "project" && answerPairs.length < pairCap) {
        answerPairs.push(...extractAnswerPairs(scoped(parsed.dialogue), ignore, pairCap - answerPairs.length));
      }
    } else {
      turns = pushTurns(turns, await (deps.parseCodexFn ?? parseCodexFile)(file));
    }
  }

  if (targets.includes("codex")) {
    const claudePrompts = turns.filter(turn => (turn.assistant ?? "claude-code") === "claude-code").length;
    const codexPrompts = turns.filter(turn => turn.assistant === "codex").length;
    log(`sources: Claude Code ${claudePrompts} prompt(s) · Codex ${codexPrompts} prompt(s)`);
  }

  try {
    const husks = await findHusks(claudeFiles, userTurnCounts);
    if (husks.length > 0) {
      log(`coverage: ${husks.length} bridged transcript(s) contain no minable prompts — those conversations live only at claude.ai`);
    }
    const missing = targets.includes("claude-code") ? await findMissingSessions(projectDir, claudeFiles, {
      sinceDays: opts.sinceDays,
      gitLogFn: deps.gitLogFn,
    }) : [];
    if (missing.length > 0) {
      log(`coverage: ${missing.length} session(s) in recent Claude-Session git trailers have no local transcript (cloud-only, another machine, or cleaned up) — results under-represent them`);
    }
  } catch (error) {
    log(`coverage check failed: ${(error as Error).message}`);
  }

  // Replay dedupe before counting, matching the events above and the report:
  // one prompt a resumed session inherited from its parent is one prompt, and
  // any other answer makes `gradient` and `gradient scan` disagree about the
  // same corpus.
  const filtered = filterPrompts(turns, ignore);
  const deduped = dedupeReplayedEvents(filtered, turnIdentity);
  const prompts = deduped.kept;
  log(
    `prompts: ${prompts.length} after filtering injected text` +
    (deduped.dropped > 0 ? ` and ${deduped.dropped} session replay(s)` : ""),
  );
  const { kept, dropped } = capByRecency(prompts, max);
  if (dropped > 0) log(`capped to most recent ${max} prompts; ${dropped} older dropped (raise with --max-prompts)`);

  let auditCandidates: Candidate[] = [];
  if (instructions.length > 0) {
    const claudePrompts = kept.filter(turn => (turn.assistant ?? "claude-code") === "claude-code");
    const result = audit(claudePrompts, instructions, { confirmedCorrections });
    const restatementFindings = result.candidates.filter(candidate =>
      candidate.hint?.startsWith("restated instruction")).length;
    const correctionFindings = result.candidates.length - restatementFindings;
    log(
      `instruction audit: ${instructions.length} instructions · ` +
      `${restatementFindings} restatement findings · ${correctionFindings} correction findings`,
    );
    await saveInstructionAudit(projectDir, result.tallies, opts.home);
    auditCandidates = result.candidates;
    const auditCandidateCap = Math.ceil(window / 3);
    if (auditCandidates.length > auditCandidateCap) {
      log(`audit candidates capped to ${auditCandidateCap}; ${auditCandidates.length - auditCandidateCap} dropped`);
      auditCandidates = auditCandidates.slice(0, auditCandidateCap);
    }
  }

  const detectedPastes = detectPasteCandidates(kept);
  const pasteFloods = detectedPastes.filter(hasTemplateFloodSupport);
  const pastes = detectedPastes.filter(candidate => !hasTemplateFloodSupport(candidate));
  const clusterInput = kept
    .filter(turn =>
      !extractPasteKey(turn.text ?? "") &&
      !(instructions.length > 0 && CORRECTION_RE.test(turn.text ?? "")))
    .map(turn => ({ ...turn, text: turn.text?.slice(0, MAX_MINED_PROMPT_CHARS) }));
  const clustered = cluster(clusterInput);
  const floods = clustered.filter(isTemplateFlood);
  const candidates = clustered.filter(candidate => !isTemplateFlood(candidate));
  const floodCount = floods.length + pasteFloods.length;
  if (floodCount > 0) log(`excluded ${floodCount} machine-template pattern(s) (CI/hook-injected, not habits)`);
  if (pastes.length > 0) log(`${pastes.length} paste pattern(s) detected`);

  if (opts.scope === "project") {
    const parseDialogueFn = deps.parseDialogueFn ?? (deps.parseFn ? undefined : parseDialogueFile);
    if (parseDialogueFn) {
      for (const file of claudeFiles) {
        if (answerPairs.length >= pairCap) break;
        answerPairs.push(...extractAnswerPairs(scoped(await parseDialogueFn(file)), ignore, pairCap - answerPairs.length));
      }
    }
    if (!productionCodexSinglePass) {
      const parseCodexDialogueFn = deps.parseCodexDialogueFn ?? (deps.parseCodexFn ? undefined : parseCodexDialogueFile);
      if (parseCodexDialogueFn) {
        for (const file of codexFiles) {
          if (answerPairs.length >= pairCap) break;
          answerPairs.push(...extractAnswerPairs(scoped(await parseCodexDialogueFn(file)), ignore, pairCap - answerPairs.length));
        }
      }
    }
  } else {
    log("repeated-answer rules skipped for cross-project scope");
  }
  const answers = mineAnswerCandidates(answerPairs);
  if (answers.length > 0) log(`${answers.length} repeated-answer pattern(s) detected`);
  const nonSequenceCandidates = [...candidates, ...pastes, ...answers];

  const signatureSet = new Set(candidates.map(candidate => candidate.signature));
  const sequence = mineSequences(clusterInput, text => {
    const normalized = normalize(text);
    return signatureSet.has(normalized) ? normalized : null;
  });
  if (sequence.capped) log(`sequence pair cap hit (${SEQ_MAX_BIGRAMS} distinct pairs) — pairs first seen after the cap were ignored`);
  // Chains carry a count floor, not a recurrence floor, so a feature iterated on
  // for one afternoon reaches it easily. Gate here rather than downstream: both
  // the sequence candidates and the committed-playbook miner read these chains,
  // and a chain that is project history must reach neither.
  const chains = sequence.chains.filter(chain => activeWindows(chain.occurrences) >= MIN_ACTIVE_WINDOWS);
  if (chains.length < sequence.chains.length) {
    log(`recurrence gate → ${sequence.chains.length - chains.length} chain(s) held back as project history`);
  }
  if (chains.length > 0) log(`sequences: ${chains.length} recurring chain(s)`);
  const sequenceCap = Math.ceil(window / 4);
  if (chains.length > sequenceCap) {
    log(`sequence candidates capped to ${sequenceCap}; ${chains.length - sequenceCap} dropped`);
  }
  const assistantBySession = new Map(clusterInput.map(turn => [turn.sessionId, turn.assistant ?? "claude-code"]));
  const sequenceCandidates: Candidate[] = chains.slice(0, sequenceCap).map(chain => ({
    kind: "sequence",
    signature: chain.steps.join(" → "),
    examples: chain.examples.map(example => example.join(" ⏎ ")),
    count: chain.count,
    sessions: chain.sessions,
    sessionIds: chain.sessionIds,
    // A chain occurrence is timestamped at its final step. Its ordered full
    // signature remains the stable identity, so memberSignatures stays empty.
    occurrences: chain.occurrences,
    memberSignatures: [],
    confidence: "high",
    assistants: [...new Set(chain.sessionIds.map(sessionId => assistantBySession.get(sessionId) ?? "claude-code"))],
  }));
  let toolCandidates: Candidate[] = [];
  if (config.mineToolEvents !== false) {
    const failures = failureLoops(toolEvents);
    const observedRituals = rituals(toolEvents);
    log(
      `tool events: ${toolEvents.length} (${toolEventsDropped} dropped) → ` +
      `${failures.length} failure loops, ${observedRituals.length} rituals`,
    );
    toolCandidates = [...failures, ...observedRituals]
      .sort((left, right) => right.count - left.count || left.signature.localeCompare(right.signature));
    const toolCandidateCap = Math.ceil(window / 3);
    if (toolCandidates.length > toolCandidateCap) {
      log(`tool-event candidates capped to ${toolCandidateCap}; ${toolCandidates.length - toolCandidateCap} dropped`);
      toolCandidates = toolCandidates.slice(0, toolCandidateCap);
    }
  }
  // Replays were already collapsed at the turn and event level, before any of
  // these producers saw their input, so counts here are of distinct sends.
  const allCandidates =
    [...nonSequenceCandidates, ...sequenceCandidates, ...toolCandidates, ...auditCandidates];
  // Runs are computed over the full kept stream, not clusterInput: a paste turn
  // sitting between two cluster members must break the run like any non-member.
  annotateTemporal(kept, allCandidates);
  // Deterministic reclassification from temporal evidence alone — no LLM
  // involved; must run before detect so a marked loop reaches both the
  // degrade path and the model's view of candidate kind.
  markLoops(allCandidates);
  // Deterministic reclassification of unprompted user pushback ("no, use
  // pnpm", "don't add comments") into kind "correction" — also no LLM
  // involved. Runs after markLoops so a candidate already reclassified as a
  // loop is left untouched (loops win ties by order); only kind-"unknown"
  // candidates are eligible.
  if (opts.scope === "project") markCorrections(allCandidates);

  // Evidence gate. Tool-event candidates are counted facts — a failure loop or
  // a post-edit ritual is real the first day it happens. Prompt-derived
  // candidates are interpretations: the same phrasing recurs both because it is
  // a ritual and because one hard feature was iterated on in a single sitting,
  // and clustering cannot tell those apart. A pattern confined to one sitting is
  // project history, so require two occasions at least 24h apart.
  const beforeGate = allCandidates.length;
  const dayGated = allCandidates.filter(candidate =>
    !CLUSTERED_PROMPT_KINDS.has(candidate.kind) ||
    activeWindows(candidate.occurrences) >= MIN_ACTIVE_WINDOWS);
  if (dayGated.length < beforeGate) {
    log(`recurrence gate → ${beforeGate - dayGated.length} prompt-derived candidate(s) held back as project history`);
  }
  // "lgtm", "looks good to me", "continue from where you left off" are
  // approvals, not workflows. They repeat constantly and across many days, so
  // no frequency or temporal rule catches them, and a skill built from one can
  // never fire usefully.
  //
  // Loops used to be exempt so the resulting loop suggestion could carry the
  // autopilot recommendation. It cannot any more — a loop artifact reads
  // `Reminder: <the prompt>` and is refused downstream as a restatement — so the
  // recommendation is made here, where it costs nothing and skips an LLM call.
  // A candidate with a derived cadence still passes: that is a schedule, not an
  // approval, and its value is the timing rather than the words.
  const gated = dayGated.filter(candidate =>
    !!candidate.cadence || !isNudgeText(candidate.signature));
  if (gated.length < dayGated.length) {
    log(`nudge filter → ${dayGated.length - gated.length} approval phrase(s) dropped; see gradient on autopilot`);
  }
  log(`mining → ${gated.length} candidate patterns; sending top ${window} to llm`);

  const backend = deps.backend !== undefined ? deps.backend : await selectBackend({ config });
  if (!backend) log("no LLM backend available — degrading to exact-repeat command suggestions only");
  const suggestions = await detect(gated, backend, {
    limit: window,
    onCap: count => log(`capped to top ${window}; ${count} lower-frequency candidates dropped`),
  });
  const generated: Suggestion[] = [];
  for (const suggestion of suggestions) {
    try {
      validateSuggestion(suggestion);
      generated.push(suggestion);
    } catch (error) {
      log(`skipping invalid suggestion: ${(error as Error).message}`);
    }
  }

  // Repetition proves the phrasing recurred; it never proves an artifact would
  // help. Drop the ones whose body is the prompt with a heading above it —
  // invoking such a skill costs more than typing the sentence it contains.
  // Runs before the playbook miner so a sequence entry cannot outlive the
  // suggestions it chains together.
  const valid = generated.filter(suggestion => !isRestatement(suggestion));
  if (valid.length < generated.length) {
    log(
      `restatement filter → ${generated.length - valid.length} suggestion(s) dropped; ` +
      "the generated artifact only repeated the prompt",
    );
  }

  // Deterministic checkpoint-hook proposal from raw /compact command evidence
  // — independent of the LLM/backend, so it works in degraded mode too.
  try {
    const hookSuggestion = hookFromEvents(events);
    // Dedupe by semantic hook type, not id: an LLM-sourced PreCompact hook
    // derives its id from whatever text candidates the model referenced, so
    // it never matches the event-derived id (same convention as the
    // Notification-hook append below).
    const hasCheckpointHook = valid.some(suggestion =>
      suggestion.payload.type === "hook" &&
      suggestion.payload.event === "PreCompact" &&
      suggestion.payload.subcommand === "checkpoint",
    );
    if (hookSuggestion && !hasCheckpointHook) {
      validateSuggestion(hookSuggestion);
      valid.push(hookSuggestion);
      log(
        `compact: ${hookSuggestion.evidence.count} /compact invocation(s) across ` +
        `${hookSuggestion.evidence.sessions} sessions — checkpoint hook suggested`,
      );
    }
  } catch (error) {
    log(`compact hook check failed: ${(error as Error).message}`);
  }

  // Attention notifications are Claude-specific lifecycle hooks. Mine only
  // project-scoped Claude transcripts even when the habit pool includes Codex.
  try {
    const attention = opts.scope === "project"
      ? await (deps.attentionFn ?? mineAttention)(claudeFiles)
      : null;
    if (
      attention &&
      !valid.some(suggestion =>
        suggestion.payload.type === "hook" && suggestion.payload.event === "Notification",
      )
    ) {
      const suggestion = attentionSuggestion(attention);
      validateSuggestion(suggestion);
      valid.push(suggestion);
      log(
        `attention: ${attention.gaps} waits ≥5min across ${attention.sessions} sessions — ` +
        "notification hook suggested",
      );
    }
  } catch (error) {
    log(`attention check failed: ${(error as Error).message}`);
  }

  try {
    if (opts.scope === "project") {
      const projectSuggestions = mineProjectPlaybook(valid, chains, assistantBySession);
      for (const suggestion of projectSuggestions) {
        validateSuggestion(suggestion);
        valid.push(suggestion);
      }
      if (projectSuggestions.length > 0) {
        log(`${projectSuggestions.length} suggestion(s) for the committed gradient.md`);
      }
    }
  } catch (error) {
    log(`gradient.md suggestion mining failed: ${(error as Error).message}`);
  }

  await saveSuggestions(projectDir, valid, opts.home);
  log(`found ${valid.length} suggestions → cached`);
  return valid;
}
