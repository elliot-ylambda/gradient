import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveTargets, saveConfig } from "../config.js";
import { selectBackend } from "../llm/index.js";
import { installHook } from "../core/settings.js";
import type { LLMBackend } from "../llm/backend.js";
import type { Assistant, Config } from "../core/types.js";
import { safeReadFile, safeWriteFile } from "../core/safeFs.js";

export interface InitResult {
  backend: string;
  configPath: string;
  skillInstalled: boolean;
  skillPaths: string[];
  sessionScanInstalled: boolean;
}

export const INIT_SKILL_MARKER = "<!-- gradient:init-skill safety=1 -->";
const INIT_SKILL_MAX_BYTES = 256_000;

async function defaultSkillSource(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFile(join(here, "..", "..", "src", "skill", "SKILL.md"), "utf8");
}

function markedSkill(source: string): string {
  if (Buffer.byteLength(source, "utf8") > INIT_SKILL_MAX_BYTES) throw new Error("bundled gradient skill exceeds size cap");
  const frontmatter = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/.exec(source);
  if (!frontmatter) throw new Error("bundled gradient skill is missing frontmatter");
  const body = source.slice(frontmatter[0].length).replace(/^<!-- gradient:init-skill[^\n]*-->\r?\n/, "");
  return `${frontmatter[0]}${INIT_SKILL_MARKER}\n${body}`;
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

  const skillPaths: string[] = [];
  const existingOwned = new Set<string>();
  let skillContent = "";
  if (opts.installSkill) {
    skillContent = markedSkill(deps.skillSource ?? (await defaultSkillSource()));
    for (const target of targets) {
      const destination = target === "codex"
        ? join(home, ".agents", "skills", "gradient", "SKILL.md")
        : join(home, ".claude", "skills", "gradient", "SKILL.md");
      try {
        const existing = await safeReadFile(home, destination, { maxBytes: INIT_SKILL_MAX_BYTES });
        if (!existing.slice(0, 2_000).includes(INIT_SKILL_MARKER)) {
          throw new Error(`refusing to overwrite unowned existing skill: ${destination}`);
        }
        existingOwned.add(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      skillPaths.push(destination);
    }
  }

  for (const destination of skillPaths) {
    if (!existingOwned.has(destination)) {
      await safeWriteFile(home, destination, skillContent, { exclusive: true, mode: 0o600 });
      continue;
    }
    const existing = await safeReadFile(home, destination, { maxBytes: INIT_SKILL_MAX_BYTES });
    if (!existing.slice(0, 2_000).includes(INIT_SKILL_MARKER)) {
      throw new Error(`refusing to overwrite skill whose ownership changed: ${destination}`);
    }
    await safeWriteFile(home, destination, skillContent, { mode: 0o600 });
  }

  if (backend) config.backend = backend.name as Config["backend"];
  if (opts.sessionScan) config.scanOnSessionStart = true;
  await saveConfig(config, home);

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
