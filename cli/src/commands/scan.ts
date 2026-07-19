import { homedir } from "node:os";
import type { Candidate, Config, Suggestion, ToolEvent, Turn } from "../core/types.js";
import { collect } from "../core/collect.js";
import { collectCodex } from "../core/collect-codex.js";
import {
  parseDialogueFile,
  parseFile,
  parseAssistantFollowedUserFile,
  parseToolEventsFile,
  type DialogueTurn,
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
import { mineSequences, SEQ_MAX_BIGRAMS } from "../core/sequence.js";
import { boundedDetectLimit, detect } from "../core/detect.js";
import { validateSuggestion } from "../core/validate.js";
import { findHusks, findMissingSessions } from "../core/coverage.js";
import { selectBackend } from "../llm/index.js";
import { loadConfig, resolveTargets } from "../config.js";
import type { LLMBackend } from "../llm/backend.js";
import { refreshRecallIndex } from "./recall.js";
import { saveSuggestions } from "./apply.js";
import { detectPasteCandidates, extractPasteKey } from "../core/paste.js";
import { ANSWER_MAX_PAIRS, extractAnswerPairs, mineAnswerCandidates } from "../core/answers.js";
import { attentionSuggestion, mineAttention } from "../core/attention.js";
import { failureLoops, rituals } from "../core/toolmine.js";
import { loadInstructions } from "../core/instructions.js";
import { audit, clearInstructionAudit, CORRECTION_RE, saveInstructionAudit } from "../core/audit.js";

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
  parseFn?: (path: string) => Promise<Turn[]>;
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
  const parseFn = deps.parseFn ?? parseFile;
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
  const parseToolEventsFn = deps.parseToolEventsFn ?? (deps.parseFn ? undefined : parseToolEventsFile);
  const parseCorrectionContextFn = deps.parseCorrectionContextFn ??
    (deps.parseFn ? undefined : parseAssistantFollowedUserFile);
  const userTurnCounts = new Map<string, number>();
  for (const file of claudeFiles) {
    const parsed = await parseFn(file);
    userTurnCounts.set(file, parsed.length);
    turns = pushTurns(turns, parsed);
    if (config.mineToolEvents !== false && parseToolEventsFn) {
      const parsedEvents = await parseToolEventsFn(file);
      toolEventsDropped += parsedEvents.dropped;
      toolEvents.push(...scoped(parsedEvents.events));
      if (toolEvents.length > MAX_TOOL_EVENTS) {
        toolEvents.sort((left, right) => left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0);
        toolEventsDropped += toolEvents.length - MAX_TOOL_EVENTS;
        toolEvents = toolEvents.slice(0, MAX_TOOL_EVENTS);
      }
    }
    if (instructions.length > 0 && parseCorrectionContextFn) {
      confirmedCorrections.push(...scoped(await parseCorrectionContextFn(file)));
      if (confirmedCorrections.length > MAX_PROMPTS_HARD_CAP) {
        confirmedCorrections = capByRecency(confirmedCorrections, MAX_PROMPTS_HARD_CAP).kept;
      }
    }
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

  const prompts = filterPrompts(turns, ignore);
  log(`prompts: ${prompts.length} after filtering injected text`);
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
  if (sequence.chains.length > 0) log(`sequences: ${sequence.chains.length} recurring chain(s)`);
  const sequenceCap = Math.ceil(window / 4);
  if (sequence.chains.length > sequenceCap) {
    log(`sequence candidates capped to ${sequenceCap}; ${sequence.chains.length - sequenceCap} dropped`);
  }
  const assistantBySession = new Map(clusterInput.map(turn => [turn.sessionId, turn.assistant ?? "claude-code"]));
  const sequenceCandidates: Candidate[] = sequence.chains.slice(0, sequenceCap).map(chain => ({
    kind: "sequence",
    signature: chain.steps.join(" → "),
    examples: chain.examples.map(example => example.join(" ⏎ ")),
    count: chain.count,
    sessions: chain.sessions,
    sessionIds: chain.sessionIds,
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
  const allCandidates = [...nonSequenceCandidates, ...sequenceCandidates, ...toolCandidates, ...auditCandidates];
  log(`mining → ${allCandidates.length} candidate patterns; sending top ${window} to llm`);

  const backend = deps.backend !== undefined ? deps.backend : await selectBackend({ config });
  if (!backend) log("no LLM backend available — degrading to exact-repeat command suggestions only");
  const suggestions = await detect(allCandidates, backend, {
    limit: window,
    onCap: count => log(`capped to top ${window}; ${count} lower-frequency candidates dropped`),
  });
  const valid: Suggestion[] = [];
  for (const suggestion of suggestions) {
    try {
      validateSuggestion(suggestion);
      valid.push(suggestion);
    } catch (error) {
      log(`skipping invalid suggestion: ${(error as Error).message}`);
    }
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

  await saveSuggestions(projectDir, valid, opts.home);
  log(`found ${valid.length} suggestions → cached`);
  await refreshRecallIndex(projectDir, opts.home);
  return valid;
}
