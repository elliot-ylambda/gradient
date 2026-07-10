import { constants } from "node:fs";
import { open } from "node:fs/promises";
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

const MAX_CODEX_BYTES = 8_000_000;
const MAX_CODEX_TURNS = 20_000;
const MAX_TURN_CHARS = 16_000;
const MAX_DIALOGUE_CHARS = 2_000;
const MAX_TOKEN_COUNT = 1_000_000_000;

function isSubagentSource(source: unknown): boolean {
  if (typeof source === "string") return source.toLowerCase().includes("subagent");
  if (!source || typeof source !== "object") return false;
  const value = source as Record<string, unknown>;
  return "subagent" in value || value.type === "subagent" || value.kind === "subagent";
}

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop()?.slice(0, 500) ?? "?";
}

function messageText(payload: Record<string, unknown>, expectedType: "input_text" | "output_text"): string {
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .filter(block => !!block && typeof block === "object")
    .map(block => {
      const item = block as Record<string, unknown>;
      return item.type === expectedType && typeof item.text === "string"
        ? item.text
        : "";
    })
    .filter(Boolean)
    .join(" ");
}

function numeric(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TOKEN_COUNT
    ? value as number
    : undefined;
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

  const boundedLines = lines.length > MAX_CODEX_TURNS * 4
    ? [lines[0], ...lines.slice(-(MAX_CODEX_TURNS * 4 - 1))]
    : lines;
  for (const line of boundedLines) {
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
      cwd = typeof payload.cwd === "string" ? payload.cwd.slice(0, 4_096) : "";
      const rawId = typeof payload.id === "string"
        ? payload.id
        : typeof payload.session_id === "string"
          ? payload.session_id
          : "?";
      sessionId = `codex:${rawId.slice(0, 200)}`;
      const git = payload.git;
      if (git && typeof git === "object" && typeof (git as Record<string, unknown>).branch === "string") {
        branch = ((git as Record<string, unknown>).branch as string).slice(0, 500);
      }
      const source = payload.source;
      subagent = typeof payload.agent_path === "string" || isSubagentSource(source);
      if (subagent) break;
      continue;
    }

    const ts = typeof record.timestamp === "string" ? record.timestamp.slice(0, 100) : "";
    if (record.type === "event_msg" && payload.type === "user_message" && typeof payload.message === "string") {
      const text = payload.message.trim().slice(0, MAX_TURN_CHARS);
      if (!text) continue;
      const turn: Turn = {
        ts, project: projectName(cwd), ...(branch ? { branch } : {}),
        role: "user", text, sessionId, assistant: "codex",
      };
      eventTurns.push(turn);
      eventDialogue.push({ role: "user", text: text.slice(0, MAX_DIALOGUE_CHARS), ts, sessionId, assistant: "codex" });
      pendingEvent = turn;
      continue;
    }

    if (record.type === "event_msg" && payload.type === "agent_message" && payload.phase === "final_answer" && typeof payload.message === "string") {
      const text = payload.message.trim().slice(-MAX_DIALOGUE_CHARS);
      if (text) eventDialogue.push({ role: "assistant", text, ts, sessionId, assistant: "codex" });
      continue;
    }

    if (record.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const text = messageText(payload, "input_text").trim().slice(0, MAX_TURN_CHARS);
      if (!text) continue;
      const turn: Turn = {
        ts, project: projectName(cwd), ...(branch ? { branch } : {}),
        role: "user", text, sessionId, assistant: "codex",
      };
      fallbackTurns.push(turn);
      fallbackDialogue.push({ role: "user", text: text.slice(0, MAX_DIALOGUE_CHARS), ts, sessionId, assistant: "codex" });
      pendingFallback = turn;
      continue;
    }

    if (record.type === "response_item" && payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer") {
      const text = messageText(payload, "output_text").trim().slice(-MAX_DIALOGUE_CHARS);
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
      if (pending && delta > 0) pending.usageTokens = Math.min(MAX_TOKEN_COUNT, (pending.usageTokens ?? 0) + delta);
    }
  }

  if (subagent) return { turns: [], dialogue: [], malformed, subagent: true };
  const useEvents = eventTurns.length > 0;
  return {
    turns: (useEvents ? eventTurns : fallbackTurns).slice(-MAX_CODEX_TURNS),
    dialogue: (useEvents ? eventDialogue : fallbackDialogue).slice(-MAX_CODEX_TURNS),
    malformed,
    subagent: false,
  };
}

async function readCodexSession(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("refusing non-regular Codex session");
    const tailLength = Math.min(metadata.size, MAX_CODEX_BYTES);
    const tailStart = Math.max(0, metadata.size - tailLength);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, tailStart);
    let tailText = tail.toString("utf8");
    if (tailStart === 0) return tailText;
    const firstTailNewline = tailText.indexOf("\n");
    tailText = firstTailNewline >= 0 ? tailText.slice(firstTailNewline + 1) : "";

    const head = Buffer.alloc(Math.min(metadata.size, 128 * 1024));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const headText = head.subarray(0, bytesRead).toString("utf8");
    const newline = headText.indexOf("\n");
    if (newline < 0) throw new Error("Codex session metadata line exceeds cap");
    return `${headText.slice(0, newline)}\n${tailText}`;
  } finally {
    await handle.close();
  }
}

export async function parseCodexFile(path: string): Promise<Turn[]> {
  return (await parseCodexSessionFile(path)).turns;
}

export async function parseCodexDialogueFile(path: string): Promise<DialogueTurn[]> {
  return (await parseCodexSessionFile(path)).dialogue;
}

/** One bounded read for callers that need both mining and dialogue views. */
export async function parseCodexSessionFile(path: string): Promise<CodexParseResult> {
  return parseCodexLines((await readCodexSession(path)).split(/\r?\n/));
}
