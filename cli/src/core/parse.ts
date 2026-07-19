import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { redact } from "./security.js";
import type { Assistant, CommandEvent, Role, ToolEvent, Turn } from "./types.js";
import { normalizeCommandName } from "./command.js";

export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const MAX_PARSED_TURNS_PER_FILE = 20_000;
export const MAX_TURN_TEXT_CHARS = 16_000;
export const MAX_DIALOGUE_TEXT_CHARS = 2_000;
const MAX_USAGE_TOKENS = 1_000_000_000;

/** Read only the newest bounded portion of a transcript. Starting mid-line is
 * harmless because the incomplete JSON record is discarded. */
async function readTranscriptTail(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("refusing non-regular transcript");
    const length = Math.min(metadata.size, MAX_TRANSCRIPT_BYTES);
    const start = Math.max(0, metadata.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let content = buffer.toString("utf8");
    if (start > 0) {
      const newline = content.indexOf("\n");
      content = newline >= 0 ? content.slice(newline + 1) : "";
    }
    return content;
  } finally {
    await handle.close();
  }
}

interface RawBlock { type?: string; text?: string }
interface RawToolBlock extends RawBlock {
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}
interface RawQuestion { question?: string }
interface RawToolUseResult {
  questions?: RawQuestion[];
  answers?: Record<string, unknown>;
}
interface Raw {
  type?: string;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | RawBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  toolUseResult?: RawToolUseResult;
}

function project(cwd: string | undefined): string {
  if (!cwd) return "?";
  return cwd.split("/").filter(Boolean).pop()?.slice(0, 500) ?? "?";
}

function parseOne(raw: Raw): Turn | null {
  if (raw.isSidechain || raw.type !== "user") return null;
  const content = raw.message?.content;
  let text: string | undefined;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const parts = content.filter(block => block.type === "text").map(block => block.text ?? "");
    text = parts.length ? parts.join(" ") : undefined;
  }
  if (!text) return null;
  return {
    ts: (raw.timestamp ?? "").slice(0, 100),
    project: project(raw.cwd),
    ...(raw.gitBranch ? { branch: raw.gitBranch.slice(0, 500) } : {}),
    sessionId: (raw.sessionId ?? "?").slice(0, 200),
    role: "user",
    text: text.slice(0, MAX_TURN_TEXT_CHARS),
    assistant: "claude-code",
  };
}

function usageTokens(raw: Raw): number {
  if (raw.isSidechain || raw.type !== "assistant") return 0;
  const usage = raw.message?.usage;
  if (!usage) return 0;
  // cache_read_input_tokens is deliberately excluded: every API step re-reads
  // the whole cached context, so summing it across a turn's tool calls counts
  // the same tokens dozens of times (at the cheapest price class). A single
  // "continue" otherwise attributes millions of tokens to a two-word prompt.
  return Math.min(MAX_USAGE_TOKENS, [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
  ].reduce<number>((sum, value) =>
    sum + (Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 0), 0));
}

export interface ParsedTranscript {
  turns: Turn[];
  events: CommandEvent[];
}

// A user turn whose text opens with a slash-command echo tag (Claude Code's
// own rendering of a typed `/foo` invocation). Anchored so a genuine prompt
// that merely mentions the tag stays a turn.
const COMMAND_TAG_RE = /^\s*<command-name>\s*([^<]*)\s*<\/command-name>/i;
const COMMAND_ENVELOPE_RE = /^\s*<command-name(?:>|\s)/i;

export function parseTranscript(lines: string[], maxTurns = MAX_PARSED_TURNS_PER_FILE): ParsedTranscript {
  const turns: Turn[] = [];
  const events: CommandEvent[] = [];
  const pendingBySession = new Map<string, Turn>();
  const limit = Math.max(1, Math.min(maxTurns, MAX_PARSED_TURNS_PER_FILE));
  const start = Math.max(0, lines.length - limit * 4);
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    let raw: Raw;
    try {
      raw = JSON.parse(line) as Raw;
    } catch {
      continue;
    }
    const turn = parseOne(raw);
    if (turn) {
      if (turn.text && COMMAND_ENVELOPE_RE.test(turn.text)) {
        // A command envelope is never a minable prompt. Invalid/empty husks are
        // dropped, and either form clears usage attribution for the prior turn.
        pendingBySession.delete(turn.sessionId);
        const match = COMMAND_TAG_RE.exec(turn.text);
        const command = normalizeCommandName(match?.[1]);
        if (command) {
          events.push({
            ts: turn.ts,
            sessionId: turn.sessionId,
            project: turn.project,
            command,
          });
          if (events.length > limit) events.shift();
        }
        continue;
      }
      turns.push(turn);
      pendingBySession.set(turn.sessionId, turn);
      if (turns.length > limit) {
        const removed = turns.shift();
        if (removed && pendingBySession.get(removed.sessionId) === removed) {
          pendingBySession.delete(removed.sessionId);
        }
      }
      continue;
    }
    const tokens = usageTokens(raw);
    const sessionId = (raw.sessionId ?? "?").slice(0, 200);
    const pending = pendingBySession.get(sessionId);
    if (pending && tokens > 0) pending.usageTokens = Math.min(MAX_USAGE_TOKENS, (pending.usageTokens ?? 0) + tokens);
  }
  return { turns, events };
}

export async function parseTranscriptFile(path: string): Promise<ParsedTranscript> {
  return parseTranscript((await readTranscriptTail(path)).split(/\r?\n/));
}

export function parseLines(lines: string[], maxTurns = MAX_PARSED_TURNS_PER_FILE): Turn[] {
  return parseTranscript(lines, maxTurns).turns;
}

export async function parseFile(path: string): Promise<Turn[]> {
  return (await parseTranscriptFile(path)).turns;
}

/** Return genuine user prompts that followed assistant activity in the same
 * session. Tool-result wrapper records do not clear the activity marker. */
export function parseAssistantFollowedUserLines(lines: string[]): Turn[] {
  const out: Turn[] = [];
  const assistantActive = new Map<string, boolean>();
  for (const line of lines.slice(-MAX_PARSED_TURNS_PER_FILE * 4)) {
    if (!line.trim()) continue;
    let raw: Raw;
    try {
      raw = JSON.parse(line) as Raw;
    } catch {
      continue;
    }
    if (raw.isSidechain) continue;
    const sessionId = (raw.sessionId ?? "?").slice(0, 200);
    if (raw.type === "assistant") {
      assistantActive.set(sessionId, true);
      continue;
    }
    if (raw.type !== "user") continue;
    const turn = parseOne(raw);
    if (!turn) continue;
    if (assistantActive.get(sessionId)) out.push(turn);
    assistantActive.set(sessionId, false);
    if (out.length > MAX_PARSED_TURNS_PER_FILE) out.shift();
  }
  return out;
}

export async function parseAssistantFollowedUserFile(path: string): Promise<Turn[]> {
  return parseAssistantFollowedUserLines((await readTranscriptTail(path)).split(/\r?\n/));
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const PER_SESSION_EVENT_CAP = 400;
const ERROR_HEAD_MAX = 120;
const TOOL_COMMAND_MAX = 1_000;

function firstLine(value: unknown): string {
  let text = "";
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value)) {
    text = value.map(block => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const candidate = block as { text?: unknown; content?: unknown };
      if (typeof candidate.text === "string") return candidate.text;
      return typeof candidate.content === "string" ? candidate.content : "";
    }).join("\n");
  }
  return text.split(/\r?\n/).find(line => line.trim())?.trim() ?? "";
}

/** Extract the deliberately small tool-activity surface used by tool mining.
 * Bash calls are emitted only after their result is paired; edit calls have
 * no useful result and are emitted at invocation time. */
export function parseToolEventLines(lines: string[]): { events: ToolEvent[]; dropped: number } {
  const pending = new Map<string, ToolEvent>();
  const perSession = new Map<string, ToolEvent[]>();
  let dropped = 0;

  const push = (event: ToolEvent): void => {
    const events = perSession.get(event.sessionId) ?? [];
    if (events.length >= PER_SESSION_EVENT_CAP) {
      events.shift();
      dropped++;
    }
    events.push(event);
    perSession.set(event.sessionId, events);
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: Raw;
    try {
      raw = JSON.parse(line) as Raw;
    } catch {
      continue;
    }
    if (raw.isSidechain) continue;
    const content = raw.message?.content;
    if (!Array.isArray(content)) continue;

    const sessionId = (raw.sessionId ?? "?").slice(0, 200);
    for (const block of content as RawToolBlock[]) {
      if (raw.type === "assistant" && block.type === "tool_use" && block.id) {
        if (block.name === "Bash") {
          const commandValue = block.input?.command;
          const command = (typeof commandValue === "string" ? commandValue.slice(0, TOOL_COMMAND_MAX + 1) : "")
            .split(/\r?\n/, 1)[0]
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, TOOL_COMMAND_MAX);
          if (command) {
            pending.set(`${sessionId}:${block.id}`, {
              ts: (raw.timestamp ?? "").slice(0, 100),
              sessionId,
              kind: "bash",
              command,
            });
          }
          continue;
        }

        if (EDIT_TOOLS.has(block.name ?? "")) {
          const fileValue = block.input?.file_path ?? block.input?.notebook_path;
          const file = typeof fileValue === "string" ? fileValue.slice(0, 1_000) : "";
          push({
            ts: (raw.timestamp ?? "").slice(0, 100),
            sessionId,
            kind: "edit",
            ...(file ? { file } : {}),
          });
        }
        continue;
      }

      if (raw.type === "user" && block.type === "tool_result" && block.tool_use_id) {
        const key = `${sessionId}:${block.tool_use_id}`;
        const event = pending.get(key);
        if (!event) continue;
        pending.delete(key);
        const isError = block.is_error === true;
        const errorHead = isError ? redact(firstLine(block.content)).slice(0, ERROR_HEAD_MAX) : "";
        push({
          ...event,
          isError,
          ...(errorHead ? { errorHead } : {}),
        });
      }
    }
  }

  return { events: [...perSession.values()].flat(), dropped };
}

export async function parseToolEventsFile(path: string): Promise<{ events: ToolEvent[]; dropped: number }> {
  return parseToolEventLines((await readTranscriptTail(path)).split(/\r?\n/));
}

export interface DialogueTurn {
  role: Role;
  text: string;
  ts: string;
  sessionId: string;
  assistant?: Assistant;
}

/** Assistant-and-user view used only for adjacent question/answer mining. */
export function parseDialogueLines(lines: string[]): DialogueTurn[] {
  const out: DialogueTurn[] = [];
  for (const line of lines.slice(-MAX_PARSED_TURNS_PER_FILE * 4)) {
    if (!line.trim()) continue;
    let raw: Raw;
    try {
      raw = JSON.parse(line) as Raw;
    } catch {
      continue;
    }
    if (raw.isSidechain || (raw.type !== "user" && raw.type !== "assistant")) continue;

    if (raw.type === "user" && raw.toolUseResult?.questions && raw.toolUseResult.answers) {
      for (const item of raw.toolUseResult.questions.slice(0, 20)) {
        const question = item.question?.trim();
        if (!question) continue;
        const answer = raw.toolUseResult.answers[question];
        if (typeof answer !== "string" || !answer.trim()) continue;
        const common = {
          ts: (raw.timestamp ?? "").slice(0, 100),
          sessionId: (raw.sessionId ?? "?").slice(0, 200),
          assistant: "claude-code" as const,
        };
        out.push({ role: "assistant", text: question.slice(-MAX_DIALOGUE_TEXT_CHARS), ...common });
        out.push({ role: "user", text: answer.slice(0, MAX_DIALOGUE_TEXT_CHARS), ...common });
      }
      continue;
    }

    const content = raw.message?.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content.filter(block => block.type === "text").map(block => block.text ?? "").join(" ");
    }
    if (!text.trim()) continue;
    out.push({
      role: raw.type,
      text: text.slice(-MAX_DIALOGUE_TEXT_CHARS),
      ts: (raw.timestamp ?? "").slice(0, 100),
      sessionId: (raw.sessionId ?? "?").slice(0, 200),
      assistant: "claude-code",
    });
  }
  return out.slice(-MAX_PARSED_TURNS_PER_FILE);
}

export async function parseDialogueFile(path: string): Promise<DialogueTurn[]> {
  return parseDialogueLines((await readTranscriptTail(path)).split(/\r?\n/));
}
