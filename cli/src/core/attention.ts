import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { endsWithQuestion } from "./answers.js";
import type { Suggestion } from "./types.js";

export const ATTENTION_MIN_GAP_MS = 300_000;
export const ATTENTION_MIN_SESSIONS = 5;

export interface AttentionStats {
  gaps: number;
  sessions: number;
  medianMinutes: number;
}

interface RawBlock {
  type?: string;
  text?: string;
}

interface RawLine {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: { content?: string | RawBlock[] };
}

function textOf(content: string | RawBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(block => block.type === "text")
    .map(block => block.text ?? "")
    .join(" ");
}

/** Extract long assistant-question → human-answer waits from one Claude JSONL
 * transcript. Sidechains and non-text tool wrappers are excluded. */
export function gapsInLines(lines: string[]): number[] {
  const gaps: number[] = [];
  let pendingQuestionAt: number | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: RawLine;
    try {
      raw = JSON.parse(line) as RawLine;
    } catch {
      continue;
    }
    if (raw.isSidechain || typeof raw.timestamp !== "string") continue;
    const timestamp = Date.parse(raw.timestamp);
    if (Number.isNaN(timestamp)) continue;

    if (raw.type === "assistant") {
      const text = textOf(raw.message?.content).trim();
      pendingQuestionAt = text && endsWithQuestion(text) ? timestamp : null;
      continue;
    }
    if (raw.type !== "user" || pendingQuestionAt === null) continue;
    if (!textOf(raw.message?.content).trim()) continue;

    const delta = timestamp - pendingQuestionAt;
    if (delta >= ATTENTION_MIN_GAP_MS) gaps.push(delta);
    pendingQuestionAt = null;
  }
  return gaps;
}

export async function mineAttention(
  files: string[],
  readFn: (path: string) => Promise<string> = path => readFile(path, "utf8"),
): Promise<AttentionStats | null> {
  const allGaps: number[] = [];
  let sessions = 0;
  for (const file of new Set(files)) {
    let content: string;
    try {
      content = await readFn(file);
    } catch {
      continue;
    }
    const gaps = gapsInLines(content.split(/\r?\n/));
    if (gaps.length === 0) continue;
    sessions++;
    allGaps.push(...gaps);
  }
  if (sessions < ATTENTION_MIN_SESSIONS) return null;

  const sorted = [...allGaps].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    gaps: allGaps.length,
    sessions,
    medianMinutes: Math.round(medianMs / 60_000),
  };
}

/** One deterministic suggestion per scope; the normal review/apply path remains
 * the authority boundary for installing or distributing the hook. */
export function attentionSuggestion(stats: AttentionStats): Suggestion {
  return {
    id: createHash("sha1").update("attention:notify").digest("hex").slice(0, 10),
    name: "notify-when-waiting",
    title: "Desktop ping when Claude Code is waiting on you",
    rationale:
      `You left Claude waiting ≥5 minutes ${stats.gaps} time(s) across ${stats.sessions} sessions ` +
      `(median ${stats.medianMinutes} min). A Notification hook can ping your desktop instead.`,
    evidence: { count: stats.gaps, sessions: stats.sessions, assistants: ["claude-code"] },
    confidence: "high",
    payload: {
      type: "hook",
      event: "Notification",
      matcher: "permission_prompt|idle_prompt",
      subcommand: "notify",
      description: "Desktop notification when Claude needs input",
    },
  };
}
