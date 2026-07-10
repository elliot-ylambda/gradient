import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Suggestion, Turn, Config, Candidate } from "../core/types.js";
import { collect } from "../core/collect.js";
import { parseFile } from "../core/parse.js";
import { filterPrompts } from "../core/filter.js";
import { capByRecency } from "../core/cap.js";
import { DEFAULT_MAX_PROMPTS, DEFAULT_DETECT_WINDOW } from "../core/scope.js";
import { cluster, normalize } from "../core/cluster.js";
import { mineSequences } from "../core/sequence.js";
import { detect } from "../core/detect.js";
import { validateSuggestion } from "../core/validate.js";
import { gradientDir } from "../core/manifest.js";
import { writePlaybook } from "../core/playbook.js";
import { findHusks, findMissingSessions } from "../core/coverage.js";
import { selectBackend } from "../llm/index.js";
import { loadConfig } from "../config.js";
import type { LLMBackend } from "../llm/backend.js";

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
  parseFn?: (path: string) => Promise<Turn[]>;
  /** Injectable Claude-Session trailer source for the coverage check. */
  gitLogFn?: (dir: string, sinceDays: number) => Promise<string>;
  log?: (msg: string) => void;
}

export async function scan(opts: ScanOptions, deps: ScanDeps = {}): Promise<Suggestion[]> {
  const log = deps.log ?? (() => {});
  const collectFn = deps.collectFn ?? ((o: ScanOptions) => collect(o));
  const parseFn = deps.parseFn ?? parseFile;

  const files = await collectFn(opts);
  log(`files: ${files.length} transcripts`);
  const turns: Turn[] = [];
  const userTurnCounts = new Map<string, number>();
  for (const f of files) {
    const t = await parseFn(f);
    userTurnCounts.set(f, t.length);
    turns.push(...t);
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

  const prompts = filterPrompts(turns);
  log(`prompts: ${prompts.length} after filtering injected text`);

  const config = deps.config ?? (await loadConfig(opts.home));
  const isAll = opts.scope === "all";
  const max = opts.maxPrompts ?? config.maxPrompts ?? (isAll ? 0 : DEFAULT_MAX_PROMPTS);
  const { kept, dropped } = capByRecency(prompts, max);
  if (dropped > 0) {
    log(`capped to most recent ${max} prompts; ${dropped} older dropped (raise with --max-prompts)`);
  }

  const candidates = cluster(kept);
  const window = opts.limit ?? DEFAULT_DETECT_WINDOW;
  log(`clustering → ${candidates.length} candidate patterns; sending top ${window} to llm`);

  // Sequence sink 1: chains join the detect window as candidates (spec §4).
  const sigSet = new Set(candidates.map(c => c.signature));
  const seq = mineSequences(kept, text => {
    const n = normalize(text);
    return sigSet.has(n) ? n : null;
  });
  if (seq.capped) log(`sequence pair cap hit — oldest pairs dropped (raise SEQ_MAX_BIGRAMS if this recurs)`);
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

  const backend = deps.backend !== undefined ? deps.backend : await selectBackend({ config });
  if (!backend) log("no LLM backend available — degrading to exact-repeat command suggestions only");
  const suggestions = await detect([...candidates, ...seqCandidates], backend, {
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

  return valid;
}
