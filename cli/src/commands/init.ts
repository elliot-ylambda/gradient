import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { saveConfig } from "../config.js";
import { selectBackend } from "../llm/index.js";
import type { LLMBackend } from "../llm/backend.js";
import type { Config } from "../core/types.js";

export interface InitResult {
  backend: string;
  configPath: string;
  skillInstalled: boolean;
}

async function defaultSkillSource(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  // tsc does not copy .md into dist/. The published package ships both `dist` and
  // `src/skill` (package.json "files"), so resolve to the source markdown:
  // <pkg>/dist/commands/init.js → <pkg>/src/skill/SKILL.md
  return readFile(join(here, "..", "..", "src", "skill", "SKILL.md"), "utf8");
}

export async function init(
  opts: { installSkill: boolean; home?: string },
  deps: { backend?: LLMBackend | null; skillSource?: string } = {},
): Promise<InitResult> {
  const home = opts.home ?? homedir();
  const backend = deps.backend !== undefined ? deps.backend : await selectBackend();
  const backendName = backend?.name ?? "none";

  const config: Config = backend ? { backend: backend.name as Config["backend"] } : {};
  await saveConfig(config, home);

  let skillInstalled = false;
  if (opts.installSkill) {
    const source = deps.skillSource ?? (await defaultSkillSource());
    const dest = join(home, ".claude", "skills", "gradient", "SKILL.md");
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, source);
    skillInstalled = true;
  }

  return { backend: backendName, configPath: join(home, ".config/gradient/config.json"), skillInstalled };
}
