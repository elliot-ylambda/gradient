import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Suggestion, Turn, Config, Candidate } from "../core/types.js";
import { collect } from "../core/collect.js";
import { collectCodex } from "../core/collect-codex.js";
import { parseFile } from "../core/parse.js";
import { parseDialogueFile, type DialogueTurn } from "../core/parse.js";
import { parseCodexDialogueFile, parseCodexFile } from "../core/parse-codex.js";
import { filterPrompts, compileIgnorePatterns, hasTemplateFloodSupport, isTemplateFlood } from "../core/filter.js";
import { capByRecency } from "../core/cap.js";
import { DEFAULT_MAX_PROMPTS, DEFAULT_DETECT_WINDOW } from "../core/scope.js";
import { cluster, normalize } from "../core/cluster.js";
import { mineSequences, SEQ_MAX_BIGRAMS } from "../core/sequence.js";
import { detect } from "../core/detect.js";
import { validateSuggestion } from "../core/validate.js";
import { gradientDir } from "../core/manifest.js";
import { writePlaybook } from "../core/playbook.js";
import { findHusks, findMissingSessions } from "../core/coverage.js";
import { selectBackend } from "../llm/index.js";
import { loadConfig, resolveTargets } from "../config.js";
import type { LLMBackend } from "../llm/backend.js";
import { refreshRecallIndex } from "./recall.js";
import { detectPasteCandidates, extractPasteKey } from "../core/paste.js";
import { extractAnswerPairs, mineAnswerCandidates } from "../core/answers.js";

export interface ScanOptions {
  scope: "project" | "all";
  projectPath?: string;
  sinceDays?: number;
  limit?: number;
  /** Ceiling on prompts entering clustering; older ones are dropped. */
  maxPrompts?: number;
  home?: string;
}

export interface ScanDeps {
  backend?: LLMBackend | null;
  /** Pre-loaded config, to avoid a redundant read by the caller. */
  config?: Config;
  collectFn?: (o: ScanOptions) => Promise<string[]>;
  collectCodexFn?: (o: ScanOptions) => Promise<string[]>;
  parseFn?: (path: string) => Promise<Turn[]>;
  parseCodexFn?: (path: string) => Promise<Turn[]>;
  /** Injectable assistant+user parser for repeated-answer mining. */
  parseDialogueFn?: (path: string) => Promise<DialogueTurn[]>;
  parseCodexDialogueFn?: (path: string) => Promise<DialogueTurn[]>;
  /** Injectable Claude-Session trailer source for the coverage check. */
  gitLogFn?: (dir: string, sinceDays: number) => Promise<string>;
  log?: (msg: string) => void;
}

export async function scan(opts: ScanOptions, deps: ScanDeps = {}): Promise<Suggestion[]> {
  const log = deps.log ?? (() => {});
  const config = deps.config ?? (await loadConfig(opts.home));
  const targets = resolveTargets(config);
  const collectFn = deps.collectFn ?? ((o: ScanOptions) => collect(o));
  const collectCodexFn = deps.collectCodexFn ?? ((o: ScanOptions) => collectCodex(o));
  const parseFn = deps.parseFn ?? parseFile;
  const parseCodexFn = deps.parseCodexFn ?? parseCodexFile;
  const projectDir = opts.projectPath ?? process.cwd();

  const claudeFiles = targets.includes("claude-code") ? await collectFn(opts) : [];
  const codexFiles = targets.includes("codex") ? await collectCodexFn(opts) : [];
  const files = [...claudeFiles, ...codexFiles];
  log(
    targets.includes("codex")
      ? `files: ${files.length} transcripts (Claude Code ${claudeFiles.length} · Codex ${codexFiles.length})`
      : `files: ${files.length} transcripts`,
  );
  const turns: Turn[] = [];
  const userTurnCounts = new Map<string, number>();
  for (const f of claudeFiles) {
    const t = await parseFn(f);
    userTurnCounts.set(f, t.length);
    turns.push(...t);
  }
  for (const f of codexFiles) turns.push(...(await parseCodexFn(f)));
  if (targets.includes("codex")) {
    const claudePrompts = turns.filter(turn => (turn.assistant ?? "claude-code") === "claude-code").length;
    const codexPrompts = turns.filter(turn => turn.assistant === "codex").length;
    log(`sources: Claude Code ${claudePrompts} prompt(s) · Codex ${codexPrompts} prompt(s)`);
  }

  // Coverage sanity: a scan over a silently shrunken corpus (bridged sessions whose
  // prompts live only at claude.ai, transcripts reaped by retention) looks identical to
  // a complete one — make the gaps loud. Advisory only; never fails the scan.
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
  } catch (e) {
    log(`coverage check failed: ${(e as Error).message}`);
  }

  const ignore = compileIgnorePatterns(config.ignorePatterns);
  const prompts = filterPrompts(turns, ignore);
  log(`prompts: ${prompts.length} after filtering injected text`);
  const isAll = opts.scope === "all";
  const max = opts.maxPrompts ?? config.maxPrompts ?? (isAll ? 0 : DEFAULT_MAX_PROMPTS);
  const { kept, dropped } = capByRecency(prompts, max);
  if (dropped > 0) {
    log(`capped to most recent ${max} prompts; ${dropped} older dropped (raise with --max-prompts)`);
  }

  const detectedPastes = detectPasteCandidates(kept);
  const pasteFloods = detectedPastes.filter(hasTemplateFloodSupport);
  const pastes = detectedPastes.filter(candidate => !hasTemplateFloodSupport(candidate));
  const clusterInput = kept.filter(turn => !extractPasteKey(turn.text ?? ""));
  const clustered = cluster(clusterInput);
  const floods = clustered.filter(isTemplateFlood);
  const candidates = clustered.filter(c => !isTemplateFlood(c));
  const floodCount = floods.length + pasteFloods.length;
  if (floodCount > 0) log(`excluded ${floodCount} machine-template pattern(s) (CI/hook-injected, not habits)`);
  if (pastes.length > 0) log(`${pastes.length} paste pattern(s) detected`);

  // Production scans read a dialogue-shaped view in a second pass. Test callers
  // that replace parseFn can independently inject this view when they need it.
  const parseDialogueFn = deps.parseDialogueFn ?? (deps.parseFn ? undefined : parseDialogueFile);
  const parseCodexDialogueFn = deps.parseCodexDialogueFn ?? (deps.parseCodexFn ? undefined : parseCodexDialogueFile);
  const dialogue: DialogueTurn[] = [];
  if (parseDialogueFn) {
    for (const file of claudeFiles) dialogue.push(...(await parseDialogueFn(file)));
  }
  if (parseCodexDialogueFn) {
    for (const file of codexFiles) dialogue.push(...(await parseCodexDialogueFn(file)));
  }
  const answers = mineAnswerCandidates(extractAnswerPairs(dialogue));
  if (answers.length > 0) log(`${answers.length} repeated-answer pattern(s) detected`);
  const nonSequenceCandidates = [...candidates, ...pastes, ...answers];
  const window = opts.limit ?? DEFAULT_DETECT_WINDOW;

  // Sequence sink 1: chains join the detect window as candidates (spec §4).
  const sigSet = new Set(candidates.map(c => c.signature));
  const seq = mineSequences(kept, text => {
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
    assistants: [...new Set(ch.sessionIds.map(sessionId =>
      kept.find(turn => turn.sessionId === sessionId)?.assistant ?? "claude-code",
    ))],
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

  const gdir = gradientDir(projectDir);
  await mkdir(gdir, { recursive: true });
  await writeFile(join(gdir, "suggestions.json"), JSON.stringify(valid, null, 2));
  log(`found ${valid.length} suggestions → cached`);

  try {
    const pb = await writePlaybook(valid, opts.home, seq.chains);
    log(pb ? `gradient.md updated → ${pb}` : "gradient.md markers missing — left untouched");
  } catch (e) {
    log(`gradient.md update failed: ${(e as Error).message}`); // never fails the scan
  }

  await refreshRecallIndex(projectDir, opts.home);

  return valid;
}
