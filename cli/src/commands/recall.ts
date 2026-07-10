import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildRecallIndex,
  loadRecallIndex,
  matchPrompt,
  NEAR_MISS_THRESHOLD,
  RECALL_THRESHOLD,
  recallIndexFresh,
  saveRecallIndex,
  type RecallIndex,
} from "../core/recall.js";
import { gradientDir } from "../core/manifest.js";
import { hookInstalled, installHook, removeHook } from "../core/settings.js";

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

export async function appendAdoption(projectDir: string, event: AdoptionEvent): Promise<void> {
  const path = join(gradientDir(projectDir), "adoption.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`);
}

/** Fail-open, local-only UserPromptSubmit hook. Every failure returns no hint. */
export async function recallHook(
  input: RecallHookInput,
  deps: { home?: string; now?: () => string } = {},
): Promise<{ context?: string }> {
  try {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (prompt.length < 15 || prompt.startsWith("/")) return {};
    const projectDir = typeof input.cwd === "string" && input.cwd.trim()
      ? input.cwd
      : process.cwd();

    let index: RecallIndex | null = await loadRecallIndex(projectDir);
    if (!index || !(await recallIndexFresh(index, projectDir, deps.home))) {
      index = await buildRecallIndex(projectDir, deps.home);
      await saveRecallIndex(projectDir, index).catch(() => undefined);
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
    await appendAdoption(projectDir, event).catch(() => undefined);
    if (!hinted) return {};

    return {
      context: `The user's prompt closely matches their installed ${match.entry.kind} "${match.entry.invocation}" (mined from their own history). Prefer following that ${match.entry.kind}'s workflow.`,
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
  if (on) {
    await saveRecallIndex(projectDir, await buildRecallIndex(projectDir, home));
    const settingsPath = await installHook(
      projectDir,
      "UserPromptSubmit",
      "gradient recall",
      { timeout: 5 },
    );
    return { installed: true, settingsPath };
  }

  const settingsPath = await removeHook(projectDir, "UserPromptSubmit", "gradient recall");
  return { installed: false, settingsPath };
}

export async function recallStatus(
  projectDir: string,
): Promise<{ installed: boolean; entries: number; builtAt?: string }> {
  const installed = await hookInstalled(projectDir, "UserPromptSubmit", "gradient recall");
  const index = await loadRecallIndex(projectDir);
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
    await saveRecallIndex(projectDir, await buildRecallIndex(projectDir, home));
  } catch {
    // The hook can rebuild inline later; the artifact operation remains valid.
  }
}
