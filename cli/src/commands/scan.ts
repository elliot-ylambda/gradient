import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Suggestion, Turn } from "../core/types.js";
import { collect } from "../core/collect.js";
import { parseFile } from "../core/parse.js";
import { filterPrompts } from "../core/filter.js";
import { cluster } from "../core/cluster.js";
import { detect } from "../core/detect.js";
import { validateSuggestion } from "../core/validate.js";
import { gradientDir } from "../core/manifest.js";
import { selectBackend } from "../llm/index.js";
import { loadConfig } from "../config.js";
import type { LLMBackend } from "../llm/backend.js";

export interface ScanOptions {
  scope: "project" | "all";
  projectPath?: string;
  sinceDays?: number;
  limit?: number;
  home?: string;
}

export interface ScanDeps {
  backend?: LLMBackend | null;
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

  const candidates = cluster(prompts);
  log(`clustering → ${candidates.length} candidate patterns`);

  const backend =
    deps.backend !== undefined ? deps.backend : await selectBackend({ config: await loadConfig(opts.home) });
  if (!backend) log("no LLM backend available — degrading to exact-repeat command suggestions only");

  const suggestions = await detect(candidates, backend, {
    limit: opts.limit ?? 12,
    onCap: dropped => log(`capped to top ${opts.limit ?? 12}; ${dropped} lower-frequency candidates dropped`),
  });
  for (const s of suggestions) validateSuggestion(s);

  const projectDir = opts.projectPath ?? process.cwd();
  await mkdir(gradientDir(projectDir), { recursive: true });
  await writeFile(join(gradientDir(projectDir), "suggestions.json"), JSON.stringify(suggestions, null, 2));
  log(`found ${suggestions.length} suggestions → cached`);
  return suggestions;
}
