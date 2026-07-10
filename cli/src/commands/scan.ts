import { homedir } from "node:os";
import type { Suggestion, Turn, Config, Candidate } from "../core/types.js";
import { collect } from "../core/collect.js";
import { parseFile } from "../core/parse.js";
import { parseDialogueFile, type DialogueTurn } from "../core/parse.js";
import { filterPrompts, compileIgnorePatterns, hasTemplateFloodSupport, isTemplateFlood } from "../core/filter.js";
import { boundedPromptLimit, capByRecency, MAX_PROMPTS_HARD_CAP } from "../core/cap.js";
import { DEFAULT_MAX_PROMPTS, DEFAULT_DETECT_WINDOW } from "../core/scope.js";
import { cluster, normalize } from "../core/cluster.js";
import { mineSequences, SEQ_MAX_BIGRAMS } from "../core/sequence.js";
import { boundedDetectLimit, detect } from "../core/detect.js";
import { validateSuggestion } from "../core/validate.js";
import { findHusks, findMissingSessions } from "../core/coverage.js";
import { selectBackend } from "../llm/index.js";
import { loadConfig } from "../config.js";
import type { LLMBackend } from "../llm/backend.js";
import { refreshRecallIndex } from "./recall.js";
import { safeWriteFile } from "../core/safeFs.js";
import { suggestionsPath } from "./apply.js";
import { detectPasteCandidates, extractPasteKey } from "../core/paste.js";
import { ANSWER_MAX_PAIRS, extractAnswerPairs, mineAnswerCandidates } from "../core/answers.js";

const MAX_MINED_PROMPT_CHARS = 4_000;

export interface ScanOptions {
  scope: "project" | "all";
  projectPath?: string;
  sinceDays?: number;
  limit?: number;
  /** Ceiling on prompts entering clustering; older ones are dropped. */
  maxPrompts?: number;
  home?: string;
  now?: number;
}

export interface ScanDeps {
  backend?: LLMBackend | null;
  /** Pre-loaded config, to avoid a redundant read by the caller. */
  config?: Config;
  collectFn?: (o: ScanOptions) => Promise<string[]>;
  parseFn?: (path: string) => Promise<Turn[]>;
  /** Injectable assistant+user parser for repeated-answer mining. */
  parseDialogueFn?: (path: string) => Promise<DialogueTurn[]>;
  /** Injectable Claude-Session trailer source for the coverage check. */
  gitLogFn?: (dir: string, sinceDays: number) => Promise<string>;
  log?: (msg: string) => void;
}

export async function scan(opts: ScanOptions, deps: ScanDeps = {}): Promise<Suggestion[]> {
  const log = deps.log ?? (() => {});
  const collectFn = deps.collectFn ?? ((o: ScanOptions) => collect(o));
  const parseFn = deps.parseFn ?? parseFile;
  const config = deps.config ?? (await loadConfig(opts.home));
  const requestedMax = opts.maxPrompts ?? config.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  const max = boundedPromptLimit(requestedMax);
  if (max !== requestedMax) log(`max-prompts safety-capped to ${max}`);

  const files = await collectFn(opts);
  log(`files: ${files.length} transcripts`);
  let turns: Turn[] = [];
  const userTurnCounts = new Map<string, number>();
  for (const f of files) {
    const t = await parseFn(f);
    userTurnCounts.set(f, t.length);
    if (opts.sinceDays === undefined) {
      turns.push(...t);
    } else {
      const cutoff = (opts.now ?? Date.now()) - opts.sinceDays * 86_400_000;
      turns.push(...t.filter(turn => {
        const ts = Date.parse(turn.ts);
        return Number.isFinite(ts) && ts >= cutoff;
      }));
    }
    if (turns.length > MAX_PROMPTS_HARD_CAP) {
      turns = capByRecency(turns, MAX_PROMPTS_HARD_CAP).kept;
    }
  }

  const projectDir = opts.projectPath ?? process.cwd();

  // Coverage sanity: a scan over a silently shrunken corpus (bridged sessions whose
  // prompts live only at claude.ai, transcripts reaped by retention) looks identical to
  // a complete one — make the gaps loud. Advisory only; never fails the scan.
  try {
    const husks = await findHusks(files, userTurnCounts);
    if (husks.length > 0) {
      log(`coverage: ${husks.length} bridged transcript(s) contain no minable prompts — those conversations live only at claude.ai`);
    }
    const missing = await findMissingSessions(projectDir, files, {
      sinceDays: opts.sinceDays,
      gitLogFn: deps.gitLogFn,
    });
    if (missing.length > 0) {
      log(`coverage: ${missing.length} session(s) in recent Claude-Session git trailers have no local transcript (cloud-only, another machine, or cleaned up) — results under-represent them`);
    }
  } catch (e) {
    log(`coverage check failed: ${(e as Error).message}`);
  }

  const ignore = compileIgnorePatterns(config.ignorePatterns);
  const prompts = filterPrompts(turns, ignore);
  log(`prompts: ${prompts.length} after filtering injected text`);
  const { kept, dropped } = capByRecency(prompts, max);
  if (dropped > 0) {
    log(`capped to most recent ${max} prompts; ${dropped} older dropped (raise with --max-prompts)`);
  }

  const detectedPastes = detectPasteCandidates(kept);
  const pasteFloods = detectedPastes.filter(hasTemplateFloodSupport);
  const pastes = detectedPastes.filter(candidate => !hasTemplateFloodSupport(candidate));
  const clusterInput = kept
    .filter(turn => !extractPasteKey(turn.text ?? ""))
    .map(turn => ({ ...turn, text: turn.text?.slice(0, MAX_MINED_PROMPT_CHARS) }));
  const clustered = cluster(clusterInput);
  const floods = clustered.filter(isTemplateFlood);
  const candidates = clustered.filter(c => !isTemplateFlood(c));
  const floodCount = floods.length + pasteFloods.length;
  if (floodCount > 0) log(`excluded ${floodCount} machine-template pattern(s) (CI/hook-injected, not habits)`);
  if (pastes.length > 0) log(`${pastes.length} paste pattern(s) detected`);

  // Production scans read a dialogue-shaped view in a second pass. Test callers
  // that replace parseFn can independently inject this view when they need it.
  const parseDialogueFn = deps.parseDialogueFn ?? (deps.parseFn ? undefined : parseDialogueFile);
  const answerPairs = [] as ReturnType<typeof extractAnswerPairs>;
  if (opts.scope === "project" && parseDialogueFn) {
    const pairCap = Math.min(ANSWER_MAX_PAIRS, max > 0 ? max : ANSWER_MAX_PAIRS);
    for (const file of files) {
      if (answerPairs.length >= pairCap) break;
      const parsed = await parseDialogueFn(file);
      let scoped: DialogueTurn[];
      if (opts.sinceDays === undefined) {
        scoped = parsed;
      } else {
        const cutoff = (opts.now ?? Date.now()) - opts.sinceDays * 86_400_000;
        scoped = parsed.filter(turn => {
          const ts = Date.parse(turn.ts);
          return Number.isFinite(ts) && ts >= cutoff;
        });
      }
      answerPairs.push(...extractAnswerPairs(scoped, ignore, pairCap - answerPairs.length));
    }
  } else if (opts.scope === "all") {
    log("repeated-answer rules skipped for cross-project scope");
  }
  const answers = mineAnswerCandidates(answerPairs);
  if (answers.length > 0) log(`${answers.length} repeated-answer pattern(s) detected`);
  const nonSequenceCandidates = [...candidates, ...pastes, ...answers];
  const requestedWindow = opts.limit ?? DEFAULT_DETECT_WINDOW;
  const window = boundedDetectLimit(requestedWindow, DEFAULT_DETECT_WINDOW);
  if (window !== requestedWindow) log(`candidate limit safety-capped to ${window}`);

  // Sequence sink 1: chains join the detect window as candidates (spec §4).
  const sigSet = new Set(candidates.map(c => c.signature));
  const seq = mineSequences(clusterInput, text => {
    const n = normalize(text);
    return sigSet.has(n) ? n : null;
  });
  if (seq.capped) log(`sequence pair cap hit (${SEQ_MAX_BIGRAMS} distinct pairs) — pairs first seen after the cap were ignored`);
  if (seq.chains.length > 0) log(`sequences: ${seq.chains.length} recurring chain(s)`);
  const seqCap = Math.ceil(window / 4);
  if (seq.chains.length > seqCap) log(`sequence candidates capped to ${seqCap}; ${seq.chains.length - seqCap} dropped`);
  const seqCandidates: Candidate[] = seq.chains.slice(0, seqCap).map(ch => ({
    kind: "sequence",
    signature: ch.steps.join(" → "),
    examples: ch.examples.map(e => e.join(" ⏎ ")),
    count: ch.count,
    sessions: ch.sessions,
    sessionIds: ch.sessionIds,
    confidence: "high",
  }));
  const allCandidates = [...nonSequenceCandidates, ...seqCandidates];
  log(`mining → ${allCandidates.length} candidate patterns; sending top ${window} to llm`);

  const backend = deps.backend !== undefined ? deps.backend : await selectBackend({ config });
  if (!backend) log("no LLM backend available — degrading to exact-repeat command suggestions only");
  const suggestions = await detect(allCandidates, backend, {
    limit: window,
    onCap: dropped => log(`capped to top ${window}; ${dropped} lower-frequency candidates dropped`),
  });
  const valid: Suggestion[] = [];
  for (const s of suggestions) {
    try {
      validateSuggestion(s);
      valid.push(s);
    } catch (e) {
      log(`skipping invalid suggestion: ${(e as Error).message}`);
    }
  }

  const userHome = opts.home ?? homedir();
  await safeWriteFile(userHome, suggestionsPath(projectDir, userHome), JSON.stringify(valid, null, 2));
  log(`found ${valid.length} suggestions → cached`);

  await refreshRecallIndex(projectDir, opts.home);

  return valid;
}
