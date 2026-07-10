import { homedir } from "node:os";
import {
  buildRecallIndex,
  loadRecallIndex,
  matchPrompt,
  NEAR_MISS_THRESHOLD,
  RECALL_THRESHOLD,
  recallIndexPath,
  recallIndexFresh,
  saveRecallIndex,
  type RecallIndex,
} from "../core/recall.js";
import { hookInstalled, installHook, removeHook } from "../core/settings.js";
import { loadConfig, projectKey, saveConfig } from "../config.js";
import { safeAppendFile } from "../core/safeFs.js";

export interface RecallHookInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

export interface AdoptionEvent {
  ts: string;
  artifact: string;
  similarity: number;
  hinted: boolean;
}

export function adoptionPath(projectDir: string, home?: string): string {
  return recallIndexPath(projectDir, home).replace(/\.json$/, ".adoption.jsonl");
}

export async function appendAdoption(projectDir: string, event: AdoptionEvent, home?: string): Promise<void> {
  const userHome = home ?? homedir();
  await safeAppendFile(userHome, adoptionPath(projectDir, userHome), `${JSON.stringify(event)}\n`);
}

/** Fail-open, local-only UserPromptSubmit hook. Every failure returns no hint. */
export async function recallHook(
  input: RecallHookInput,
  deps: { home?: string; now?: () => string } = {},
): Promise<{ context?: string }> {
  try {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (prompt.length < 15 || prompt.length > 8_000 || prompt.startsWith("/")) return {};
    const projectDir = typeof input.cwd === "string" && input.cwd.trim()
      ? input.cwd
      : process.cwd();
    const config = await loadConfig(deps.home);
    if (!(config.recallProjects ?? []).includes(projectKey(projectDir))) return {};

    let index: RecallIndex | null = await loadRecallIndex(projectDir, deps.home);
    if (!index || !(await recallIndexFresh(index, projectDir, deps.home))) {
      index = await buildRecallIndex(projectDir, deps.home);
      await saveRecallIndex(projectDir, index, deps.home).catch(() => undefined);
    }

    const match = matchPrompt(prompt, index);
    if (!match || match.score < NEAR_MISS_THRESHOLD) return {};

    const hinted = match.score >= RECALL_THRESHOLD;
    const event: AdoptionEvent = {
      ts: (deps.now ?? (() => new Date().toISOString()))(),
      artifact: match.entry.name,
      similarity: Number(match.score.toFixed(3)),
      hinted,
    };
    await appendAdoption(projectDir, event, deps.home).catch(() => undefined);
    if (!hinted) return {};

    return {
      context: `The user's prompt closely matches their installed ${match.entry.kind} "/${match.entry.name}". Consider using that ${match.entry.kind}'s workflow.`,
    };
  } catch {
    return {};
  }
}

export async function setRecall(
  on: boolean,
  projectDir: string,
  home?: string,
): Promise<{ installed: boolean; settingsPath: string }> {
  const config = await loadConfig(home);
  const key = projectKey(projectDir);
  const projects = new Set(config.recallProjects ?? []);
  if (on) {
    await saveRecallIndex(projectDir, await buildRecallIndex(projectDir, home), home);
    const settingsPath = await installHook(
      projectDir,
      "UserPromptSubmit",
      "gradient recall",
      { timeout: 5 },
    );
    projects.add(key);
    config.recallProjects = [...projects].sort();
    try {
      await saveConfig(config, home);
    } catch (error) {
      await removeHook(projectDir, "UserPromptSubmit", "gradient recall").catch(() => undefined);
      throw error;
    }
    return { installed: true, settingsPath };
  }

  projects.delete(key);
  config.recallProjects = [...projects].sort();
  await saveConfig(config, home);
  const settingsPath = await removeHook(projectDir, "UserPromptSubmit", "gradient recall");
  return { installed: false, settingsPath };
}

export async function recallStatus(
  projectDir: string,
  home?: string,
): Promise<{ installed: boolean; entries: number; builtAt?: string }> {
  const config = await loadConfig(home);
  const installed = (config.recallProjects ?? []).includes(projectKey(projectDir)) &&
    await hookInstalled(projectDir, "UserPromptSubmit", "gradient recall");
  const index = await loadRecallIndex(projectDir, home);
  return {
    installed,
    entries: index?.entries.length ?? 0,
    ...(index ? { builtAt: index.builtAt } : {}),
  };
}

/** Best-effort derived index refresh. Artifact mutations must never fail just
 * because the recall cache cannot be written. */
export async function refreshRecallIndex(projectDir: string, home?: string): Promise<void> {
  try {
    const config = await loadConfig(home);
    if (!(config.recallProjects ?? []).includes(projectKey(projectDir))) return;
    await saveRecallIndex(projectDir, await buildRecallIndex(projectDir, home), home);
  } catch {
    // The hook can rebuild inline later; the artifact operation remains valid.
  }
}
