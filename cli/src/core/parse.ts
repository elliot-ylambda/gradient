import { readFile } from "node:fs/promises";
import type { Turn, Role } from "./types.js";

interface RawBlock { type?: string; text?: string }
interface Raw {
  type?: string;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: { role?: string; content?: string | RawBlock[] };
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
  const content = await readFile(path, "utf8");
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
  const content = await readFile(path, "utf8");
  return parseDialogueLines(content.split(/\r?\n/));
}
