import { readFile } from "node:fs/promises";
import type { Turn } from "./types.js";
import type { DialogueTurn } from "./parse.js";

interface RecordShape {
  type?: unknown;
  timestamp?: unknown;
  payload?: Record<string, unknown>;
}

export interface CodexParseResult {
  turns: Turn[];
  dialogue: DialogueTurn[];
  malformed: number;
  subagent: boolean;
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? "?";
}

function messageText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .filter(block => !!block && typeof block === "object")
    .map(block => {
      const item = block as Record<string, unknown>;
      return (item.type === "input_text" || item.type === "output_text") && typeof item.text === "string"
        ? item.text
        : "";
    })
    .filter(Boolean)
    .join(" ");
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Parse Codex rollout records while ignoring tools, developer messages, and reasoning. */
export function parseCodexLines(lines: string[]): CodexParseResult {
  const eventTurns: Turn[] = [];
  const fallbackTurns: Turn[] = [];
  const eventDialogue: DialogueTurn[] = [];
  const fallbackDialogue: DialogueTurn[] = [];
  let malformed = 0;
  let metaSeen = false;
  let subagent = false;
  let cwd = "";
  let branch: string | undefined;
  let sessionId = "codex:?";
  let previousCumulative = 0;
  let pendingEvent: Turn | undefined;
  let pendingFallback: Turn | undefined;

  for (const line of lines) {
    if (!line.trim()) continue;
    let record: RecordShape;
    try {
      record = JSON.parse(line) as RecordShape;
    } catch {
      malformed++;
      continue;
    }
    const payload = record.payload;
    if (!payload || typeof payload !== "object") continue;

    if (record.type === "session_meta" && !metaSeen) {
      metaSeen = true;
      cwd = typeof payload.cwd === "string" ? payload.cwd : "";
      const rawId = typeof payload.id === "string"
        ? payload.id
        : typeof payload.session_id === "string"
          ? payload.session_id
          : "?";
      sessionId = `codex:${rawId}`;
      const git = payload.git;
      if (git && typeof git === "object" && typeof (git as Record<string, unknown>).branch === "string") {
        branch = (git as Record<string, unknown>).branch as string;
      }
      const source = payload.source;
      subagent = typeof payload.agent_path === "string" || (
        !!source && typeof source === "object" && "subagent" in (source as Record<string, unknown>)
      );
      if (subagent) break;
      continue;
    }

    const ts = typeof record.timestamp === "string" ? record.timestamp : "";
    if (record.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
      const text = payload.message.trim();
      if (!text) continue;
      const turn: Turn = {
        ts,
        project: projectName(cwd),
        ...(branch ? { branch } : {}),
        role: "user",
        text,
        sessionId,
        assistant: "codex",
      };
      eventTurns.push(turn);
      eventDialogue.push({ role: "user", text, ts, sessionId, assistant: "codex" });
      pendingEvent = turn;
      continue;
    }

    if (record.type === "event_msg" && payload.type === "agent_message" && payload.phase === "final_answer" && typeof payload.message === "string") {
      const text = payload.message.trim();
      if (text) eventDialogue.push({ role: "assistant", text, ts, sessionId, assistant: "codex" });
      continue;
    }

    if (record.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const text = messageText(payload).trim();
      if (!text) continue;
      const turn: Turn = {
        ts,
        project: projectName(cwd),
        ...(branch ? { branch } : {}),
        role: "user",
        text,
        sessionId,
        assistant: "codex",
      };
      fallbackTurns.push(turn);
      fallbackDialogue.push({ role: "user", text, ts, sessionId, assistant: "codex" });
      pendingFallback = turn;
      continue;
    }

    if (record.type === "response_item" && payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer") {
      const text = messageText(payload).trim();
      if (text) fallbackDialogue.push({ role: "assistant", text, ts, sessionId, assistant: "codex" });
      continue;
    }

    if (record.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info;
      if (!info || typeof info !== "object") continue;
      const totalUsage = (info as Record<string, unknown>).total_token_usage;
      const total = totalUsage && typeof totalUsage === "object"
        ? numeric((totalUsage as Record<string, unknown>).total_tokens)
        : undefined;
      if (total === undefined || total < previousCumulative) continue;
      const delta = total - previousCumulative;
      previousCumulative = total;
      const pending = pendingEvent ?? pendingFallback;
      if (pending && delta > 0) pending.usageTokens = (pending.usageTokens ?? 0) + delta;
    }
  }

  if (subagent) return { turns: [], dialogue: [], malformed, subagent: true };
  const useEvents = eventTurns.length > 0;
  return {
    turns: useEvents ? eventTurns : fallbackTurns,
    dialogue: useEvents ? eventDialogue : fallbackDialogue,
    malformed,
    subagent: false,
  };
}

export async function parseCodexFile(path: string): Promise<Turn[]> {
  const content = await readFile(path, "utf8");
  return parseCodexLines(content.split(/\r?\n/)).turns;
}

export async function parseCodexDialogueFile(path: string): Promise<DialogueTurn[]> {
  const content = await readFile(path, "utf8");
  return parseCodexLines(content.split(/\r?\n/)).dialogue;
}
