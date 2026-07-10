import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveTargets, saveConfig } from "../config.js";
import { selectBackend } from "../llm/index.js";
import { installHook } from "../core/settings.js";
import type { LLMBackend } from "../llm/backend.js";
import type { Assistant, Config } from "../core/types.js";

export interface InitResult {
  backend: string;
  configPath: string;
  skillInstalled: boolean;
  skillPaths: string[];
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
  opts: {
    installSkill: boolean;
    sessionScan?: boolean;
    home?: string;
    projectDir?: string;
    targets?: Assistant[];
  },
  deps: { backend?: LLMBackend | null; skillSource?: string } = {},
): Promise<InitResult> {
  const home = opts.home ?? homedir();
  const config: Config = { ...(await loadConfig(home)) };
  if (opts.targets) config.targets = opts.targets;
  const targets = resolveTargets(config);
  if (opts.sessionScan && !targets.includes("claude-code")) {
    throw new Error("--session-scan currently requires the claude-code target");
  }
  const backend = deps.backend !== undefined ? deps.backend : await selectBackend({ config });
  const backendName = backend?.name ?? "none";

  if (backend) config.backend = backend.name as Config["backend"];
  if (opts.sessionScan) config.scanOnSessionStart = true;
  await saveConfig(config, home);

  const skillPaths: string[] = [];
  if (opts.installSkill) {
    const source = deps.skillSource ?? (await defaultSkillSource());
    for (const target of targets) {
      const dest = target === "codex"
        ? join(home, ".agents", "skills", "gradient", "SKILL.md")
        : join(home, ".claude", "skills", "gradient", "SKILL.md");
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, source);
      skillPaths.push(dest);
    }
  }

  let sessionScanInstalled = false;
  if (opts.sessionScan) {
    await installHook(opts.projectDir ?? process.cwd(), "SessionStart", "gradient scan --detach");
    sessionScanInstalled = true;
  }

  return {
    backend: backendName,
    configPath: join(home, ".config/gradient/config.json"),
    skillInstalled: skillPaths.length > 0,
    skillPaths,
    sessionScanInstalled,
  };
}
