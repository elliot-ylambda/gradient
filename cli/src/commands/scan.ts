import { homedir } from "node:os";
import type { Suggestion, Turn, Config } from "../core/types.js";
import { collect } from "../core/collect.js";
import { parseFile } from "../core/parse.js";
import { filterPrompts, compileIgnorePatterns, isTemplateFlood } from "../core/filter.js";
import { capByRecency } from "../core/cap.js";
import { DEFAULT_MAX_PROMPTS, DEFAULT_DETECT_WINDOW } from "../core/scope.js";
import { cluster } from "../core/cluster.js";
import { detect } from "../core/detect.js";
import { validateSuggestion } from "../core/validate.js";
import { findHusks, findMissingSessions } from "../core/coverage.js";
import { selectBackend } from "../llm/index.js";
import { loadConfig } from "../config.js";
import type { LLMBackend } from "../llm/backend.js";
import { refreshRecallIndex } from "./recall.js";
import { safeWriteFile } from "../core/safeFs.js";
import { suggestionsPath } from "./apply.js";

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
    if (opts.sinceDays === undefined) {
      turns.push(...t);
    } else {
      const cutoff = (opts.now ?? Date.now()) - opts.sinceDays * 86_400_000;
      turns.push(...t.filter(turn => {
        const ts = Date.parse(turn.ts);
        return Number.isFinite(ts) && ts >= cutoff;
      }));
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

  const config = deps.config ?? (await loadConfig(opts.home));
  const ignore = compileIgnorePatterns(config.ignorePatterns);
  const prompts = filterPrompts(turns, ignore);
  log(`prompts: ${prompts.length} after filtering injected text`);
  const max = opts.maxPrompts ?? config.maxPrompts ?? DEFAULT_MAX_PROMPTS;
  const { kept, dropped } = capByRecency(prompts, max);
  if (dropped > 0) {
    log(`capped to most recent ${max} prompts; ${dropped} older dropped (raise with --max-prompts)`);
  }

  const clustered = cluster(kept);
  const floods = clustered.filter(isTemplateFlood);
  const candidates = clustered.filter(c => !isTemplateFlood(c));
  if (floods.length > 0) log(`excluded ${floods.length} machine-template pattern(s) (CI/hook-injected, not habits)`);
  const window = opts.limit ?? DEFAULT_DETECT_WINDOW;
  log(`clustering → ${candidates.length} candidate patterns; sending top ${window} to llm`);

  const backend = deps.backend !== undefined ? deps.backend : await selectBackend({ config });
  if (!backend) log("no LLM backend available — degrading to exact-repeat command suggestions only");
  const suggestions = await detect(candidates, backend, {
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
