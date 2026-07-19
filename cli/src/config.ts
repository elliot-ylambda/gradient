import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Assistant, Config } from "./core/types.js";
import { safeReadFile, safeWriteFile } from "./core/safeFs.js";

const CONFIG_MAX_BYTES = 1_000_000;
const ASSISTANTS: ReadonlySet<string> = new Set(["claude-code", "codex"]);
const BACKENDS: ReadonlySet<string> = new Set(["claude-cli", "codex-cli", "anthropic"]);
const AUTOPILOT_MODES: ReadonlySet<string> = new Set(["off", "nudge", "full"]);
const CONSENT_PROJECT_CAP = 1_000;
const PROJECT_PATH_CAP = 4_096;

function validProjectPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= PROJECT_PATH_CAP &&
    isAbsolute(value) && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validateProjectList(value: unknown, key: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > CONSENT_PROJECT_CAP || !value.every(validProjectPath)) {
    throw new Error(`config ${key} must be a bounded array of absolute project paths`);
  }
}

function validateAutopilotProjects(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config autopilotProjects must be an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > CONSENT_PROJECT_CAP || entries.some(([path, mode]) =>
    !validProjectPath(path) || typeof mode !== "string" || !AUTOPILOT_MODES.has(mode)
  )) {
    throw new Error("config autopilotProjects must map bounded absolute project paths to known modes");
  }
}

function validateOptionalInteger(value: unknown, key: string, min: number, max: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)) {
    throw new Error(`config ${key} must be an integer from ${min} to ${max}`);
  }
}

export function configPath(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "config.json");
}

export function projectKey(projectDir: string): string {
  const absolute = resolve(projectDir);
  try {
    return realpathSync.native(absolute);
  } catch {
    // Status/help may be asked before a path exists; the resolved absolute path
    // is still a safe fail-closed key in that case.
    return absolute;
  }
}

export function projectCacheKey(projectDir: string): string {
  return createHash("sha256").update(projectKey(projectDir)).digest("hex").slice(0, 24);
}

export function projectCacheDir(projectDir: string, home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "projects", projectCacheKey(projectDir));
}

function validateModel(value: unknown, key: string, allowEmpty = false): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`config ${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed && allowEmpty) return undefined;
  if (!/^[A-Za-z0-9._:/-]{1,200}$/.test(trimmed)) {
    throw new Error(`config ${key} must be a bounded model identifier`);
  }
  return trimmed;
}

function validateConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config must be an object");
  }
  const config = value as Config;
  if (config.backend !== undefined && !BACKENDS.has(config.backend)) {
    throw new Error(`unknown backend: ${String(config.backend)}`);
  }
  validateModel(config.model, "model");
  validateModel(config.codexModel, "codexModel");
  validateModel(config.autopilotModel, "autopilotModel");
  validateOptionalInteger(config.userScopeDays, "userScopeDays", 1, 36_500);
  validateOptionalInteger(config.maxPrompts, "maxPrompts", 1, 1_000_000_000);
  validateOptionalInteger(config.autopilotBudget, "autopilotBudget", 0, 1_000_000_000);
  if (config.scanOnSessionStart !== undefined && typeof config.scanOnSessionStart !== "boolean") {
    throw new Error("config scanOnSessionStart must be a boolean");
  }
  if (config.mineToolEvents !== undefined && typeof config.mineToolEvents !== "boolean") {
    throw new Error("config mineToolEvents must be a boolean");
  }
  if (config.autopilot !== undefined && !AUTOPILOT_MODES.has(config.autopilot)) {
    throw new Error("config autopilot must be off, nudge, or full");
  }
  validateAutopilotProjects(config.autopilotProjects);
  validateProjectList(config.recallProjects, "recallProjects");
  validateProjectList(config.continuityProjects, "continuityProjects");
  if (config.ignorePatterns !== undefined && (
    !Array.isArray(config.ignorePatterns) || config.ignorePatterns.length > 20 ||
    config.ignorePatterns.some(pattern => typeof pattern !== "string" || pattern.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(pattern))
  )) {
    throw new Error("config ignorePatterns must be a bounded string array");
  }
  if (config.emitTarget !== undefined && config.emitTarget !== "skill" && config.emitTarget !== "command") {
    throw new Error("config emitTarget must be skill or command");
  }
  resolveTargets(config);
  resolveCheapModel(config);
  return config;
}

export async function loadConfig(home?: string): Promise<Config> {
  const userHome = home ?? homedir();
  try {
    const parsed = JSON.parse(await safeReadFile(
      userHome,
      configPath(userHome),
      { maxBytes: CONFIG_MAX_BYTES },
    )) as unknown;
    return validateConfig(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`refusing unreadable gradient config: ${(error as Error).message}`);
  }
}

export async function saveConfig(config: Config, home?: string): Promise<void> {
  validateConfig(config);
  const userHome = home ?? homedir();
  await safeWriteFile(userHome, configPath(userHome), `${JSON.stringify(config, null, 2)}\n`);
}

export const DEFAULT_AUTOPILOT_BUDGET = 10;
export const MAX_AUTOPILOT_BUDGET = 100;
export const DEFAULT_AUTOPILOT_MODEL = "haiku";
export const DEFAULT_CHEAP_SKILL_MODEL = "haiku";

export function boundedAutopilotBudget(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return DEFAULT_AUTOPILOT_BUDGET;
  return Math.min(value as number, MAX_AUTOPILOT_BUDGET);
}

/** Resolve and validate the assistant targets in user-authored config. */
export function resolveTargets(config: Config): Assistant[] {
  const raw = config.targets as unknown;
  if (raw === undefined) return ["claude-code"];
  if (!Array.isArray(raw)) throw new Error("config targets must be an array");
  if (raw.length === 0) throw new Error("config targets must list at least one assistant");
  if (raw.length > 16) throw new Error("config targets exceeds the bounded list cap");
  const targets: Assistant[] = [];
  for (const target of raw) {
    if (typeof target !== "string" || !ASSISTANTS.has(target)) {
      throw new Error(`unknown target: ${String(target)} (use \"claude-code\" or \"codex\")`);
    }
    if (!targets.includes(target as Assistant)) targets.push(target as Assistant);
  }
  if (targets.length > ASSISTANTS.size) throw new Error("config targets lists too many assistants");
  return targets;
}

export function resolveCheapModel(config: Config): string | undefined {
  const value = config.cheapSkillModel as unknown;
  if (value === undefined) return DEFAULT_CHEAP_SKILL_MODEL;
  return validateModel(value, "cheapSkillModel", true);
}
