import { open } from "node:fs/promises";
import type { Turn, Role } from "./types.js";

export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/** Read only the newest bounded portion of a transcript. Starting mid-line is
 * harmless because the incomplete JSON record is discarded. */
async function readTranscriptTail(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, MAX_TRANSCRIPT_BYTES);
    const start = Math.max(0, stat.size - length);
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
  message?: { role?: string; content?: string | RawBlock[] };
  toolUseResult?: RawToolUseResult;
}

function project(cwd: string | undefined): string {
  if (!cwd) return "?";
  return cwd.split("/").filter(Boolean).pop() ?? "?";
}

// Mining pipeline: genuine user prompts only. Assistant turns + tool activity
// are consumed separately by core/tail.ts for the autopilot judge.
function parseOne(line: string): Turn | null {
  let raw: Raw;
  try {
    raw = JSON.parse(line) as Raw;
  } catch {
    return null;
  }
  if (raw.isSidechain || raw.type !== "user") return null;
  const content = raw.message?.content;
  let text: string | undefined;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const parts = content.filter(b => b.type === "text").map(b => b.text ?? "");
    text = parts.length ? parts.join(" ") : undefined;
  }
  if (!text) return null;
  return {
    ts: raw.timestamp ?? "",
    project: project(raw.cwd),
    branch: raw.gitBranch,
    sessionId: raw.sessionId ?? "?",
    role: "user",
    text,
  };
}

export function parseLines(lines: string[]): Turn[] {
  const out: Turn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const t = parseOne(line);
    if (t) out.push(t);
  }
  return out;
}

export async function parseFile(path: string): Promise<Turn[]> {
  const content = await readTranscriptTail(path);
  return parseLines(content.split(/\r?\n/));
}

export interface DialogueTurn {
  role: Role;
  text: string;
  ts: string;
  sessionId: string;
}

/** Assistant-and-user view used only for adjacent question/answer mining. */
export function parseDialogueLines(lines: string[]): DialogueTurn[] {
  const out: DialogueTurn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: Raw;
    try {
      raw = JSON.parse(line) as Raw;
    } catch {
      continue;
    }
    if (raw.isSidechain || (raw.type !== "user" && raw.type !== "assistant")) continue;

    // AskUserQuestion responses are stored as a tool_result wrapper, but the
    // top-level result preserves the user-authored answer separately. Rebuild
    // alternating Q→A turns from that structured data; never mine the wrapper.
    if (raw.type === "user" && raw.toolUseResult?.questions && raw.toolUseResult.answers) {
      for (const item of raw.toolUseResult.questions) {
        const question = item.question?.trim();
        if (!question) continue;
        const answer = raw.toolUseResult.answers[question];
        if (typeof answer !== "string" || !answer.trim()) continue;
        const common = { ts: raw.timestamp ?? "", sessionId: raw.sessionId ?? "?" };
        out.push({ role: "assistant", text: question, ...common });
        out.push({ role: "user", text: answer, ...common });
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
      text,
      ts: raw.timestamp ?? "",
      sessionId: raw.sessionId ?? "?",
    });
  }
  return out;
}

export async function parseDialogueFile(path: string): Promise<DialogueTurn[]> {
  const content = await readTranscriptTail(path);
  return parseDialogueLines(content.split(/\r?\n/));
}
