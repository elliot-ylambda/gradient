import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./core/types.js";
import type { Assistant } from "./core/types.js";

export function configPath(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "config.json");
}

export async function loadConfig(home?: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(configPath(home), "utf8");
  } catch {
    return {};
  }
  const config = JSON.parse(raw) as Config;
  // Settings are user-authored. Reject invalid target/model values instead of
  // silently falling back and writing artifacts somewhere the user did not ask.
  resolveTargets(config);
  resolveCheapModel(config);
  return config;
}

export async function saveConfig(c: Config, home?: string): Promise<void> {
  resolveTargets(c);
  resolveCheapModel(c);
  const p = configPath(home);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(c, null, 2));
}

export const DEFAULT_AUTOPILOT_BUDGET = 10;
export const DEFAULT_AUTOPILOT_MODEL = "haiku";
export const DEFAULT_CHEAP_SKILL_MODEL = "haiku";

const ASSISTANTS: ReadonlySet<string> = new Set(["claude-code", "codex"]);

/** Resolve and validate the assistant targets in user-authored config. */
export function resolveTargets(config: Config): Assistant[] {
  const raw = config.targets as unknown;
  if (raw === undefined) return ["claude-code"];
  if (!Array.isArray(raw)) throw new Error("config targets must be an array");
  if (raw.length === 0) throw new Error("config targets must list at least one assistant");
  const targets: Assistant[] = [];
  for (const target of raw) {
    if (typeof target !== "string" || !ASSISTANTS.has(target)) {
      throw new Error(`unknown target: ${String(target)} (use "claude-code" or "codex")`);
    }
    if (!targets.includes(target as Assistant)) targets.push(target as Assistant);
  }
  return targets;
}

export function resolveCheapModel(config: Config): string | undefined {
  const value = config.cheapSkillModel as unknown;
  if (value === undefined) return DEFAULT_CHEAP_SKILL_MODEL;
  if (typeof value !== "string") throw new Error("config cheapSkillModel must be a string");
  return value.trim() || undefined;
}
