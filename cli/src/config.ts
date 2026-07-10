import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { Config } from "./core/types.js";
import { safeReadFile, safeWriteFile } from "./core/safeFs.js";

export function configPath(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "config.json");
}

export function projectKey(projectDir: string): string {
  return resolve(projectDir);
}

export function projectCacheKey(projectDir: string): string {
  return createHash("sha256").update(projectKey(projectDir)).digest("hex").slice(0, 24);
}

export function projectCacheDir(projectDir: string, home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "projects", projectCacheKey(projectDir));
}

export async function loadConfig(home?: string): Promise<Config> {
  const userHome = home ?? homedir();
  try {
    return JSON.parse(await safeReadFile(userHome, configPath(userHome))) as Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`refusing unreadable gradient config: ${(error as Error).message}`);
  }
}

export async function saveConfig(c: Config, home?: string): Promise<void> {
  const userHome = home ?? homedir();
  await safeWriteFile(userHome, configPath(userHome), JSON.stringify(c, null, 2));
}

export const DEFAULT_AUTOPILOT_BUDGET = 10;
export const DEFAULT_AUTOPILOT_MODEL = "haiku";
