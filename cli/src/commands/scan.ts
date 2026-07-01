import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Suggestion, Turn, Config } from "../core/types.js";
import { collect } from "../core/collect.js";
import { parseFile } from "../core/parse.js";
import { filterPrompts } from "../core/filter.js";
import { capByRecency } from "../core/cap.js";
import { DEFAULT_MAX_PROMPTS, DEFAULT_DETECT_WINDOW } from "../core/scope.js";
import { cluster } from "../core/cluster.js";
import { detect } from "../core/detect.js";
import { validateSuggestion } from "../core/validate.js";
import { gradientDir } from "../core/manifest.js";
import { writePlaybook } from "../core/playbook.js";
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
  log?: (msg: string) => void;
}

export async function scan(opts: ScanOptions, deps: ScanDeps = {}): Promise<Suggestion[]> {
  const log = deps.log ?? (() => {});
  const collectFn = deps.collectFn ?? ((o: ScanOptions) => collect(o));
  const parseFn = deps.parseFn ?? parseFile;

  const files = await collectFn(opts);
  log(`files: ${files.length} transcripts`);
  const turns: Turn[] = [];
  for (const f of files) turns.push(...(await parseFn(f)));

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

  const projectDir = opts.projectPath ?? process.cwd();
  const gdir = gradientDir(projectDir);
  await mkdir(gdir, { recursive: true });
  await writeFile(join(gdir, "suggestions.json"), JSON.stringify(valid, null, 2));
  log(`found ${valid.length} suggestions → cached`);

  try {
    const pb = await writePlaybook(valid, opts.home);
    log(pb ? `playbook updated → ${pb}` : "playbook markers missing — left untouched");
  } catch (e) {
    log(`playbook update failed: ${(e as Error).message}`); // never fails the scan
  }

  return valid;
}
