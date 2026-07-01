import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./core/types.js";

export function configPath(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "config.json");
}

export async function loadConfig(home?: string): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(home), "utf8")) as Config;
  } catch {
    return {};
  }
}

export async function saveConfig(c: Config, home?: string): Promise<void> {
  const p = configPath(home);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(c, null, 2));
}

export const DEFAULT_AUTOPILOT_BUDGET = 10;
export const DEFAULT_AUTOPILOT_MODEL = "haiku";
