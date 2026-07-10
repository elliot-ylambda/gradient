import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "../config.js";
import { selectBackend } from "../llm/index.js";
import { installHook } from "../core/settings.js";
import type { LLMBackend } from "../llm/backend.js";
import type { Config } from "../core/types.js";
import { safeWriteFile } from "../core/safeFs.js";

export interface InitResult {
  backend: string;
  configPath: string;
  skillInstalled: boolean;
  sessionScanInstalled: boolean;
}

async function defaultSkillSource(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  // tsc does not copy .md into dist/. The published package ships both `dist` and
  // `src/skill` (package.json "files"), so resolve to the source markdown:
  // <pkg>/dist/commands/init.js → <pkg>/src/skill/SKILL.md
  return readFile(join(here, "..", "..", "src", "skill", "SKILL.md"), "utf8");
}

export async function init(
  opts: { installSkill: boolean; sessionScan?: boolean; home?: string; projectDir?: string },
  deps: { backend?: LLMBackend | null; skillSource?: string } = {},
): Promise<InitResult> {
  const home = opts.home ?? homedir();
  const backend = deps.backend !== undefined ? deps.backend : await selectBackend();
  const backendName = backend?.name ?? "none";

  const config: Config = { ...(await loadConfig(home)) };
  if (backend) config.backend = backend.name as Config["backend"];
  if (opts.sessionScan) config.scanOnSessionStart = true;
  await saveConfig(config, home);

  let skillInstalled = false;
  if (opts.installSkill) {
    const source = deps.skillSource ?? (await defaultSkillSource());
    const dest = join(home, ".claude", "skills", "gradient", "SKILL.md");
    await safeWriteFile(home, dest, source);
    skillInstalled = true;
  }

  let sessionScanInstalled = false;
  if (opts.sessionScan) {
    await installHook(opts.projectDir ?? process.cwd(), "SessionStart", "gradient scan --detach");
    sessionScanInstalled = true;
  }

  return { backend: backendName, configPath: join(home, ".config/gradient/config.json"), skillInstalled, sessionScanInstalled };
}
