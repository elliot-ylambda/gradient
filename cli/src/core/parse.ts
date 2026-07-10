import { readFile } from "node:fs/promises";
import type { Assistant, Turn, Role } from "./types.js";

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
  return cwd.split("/").filter(Boolean).pop() ?? "?";
}

// Mining pipeline: genuine user prompts only. Assistant turns + tool activity
// are consumed separately by core/tail.ts for the autopilot judge.
function parseOne(raw: Raw): Turn | null {
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
    assistant: "claude-code",
  };
}

function usageTokens(raw: Raw): number {
  if (raw.isSidechain || raw.type !== "assistant") return 0;
  const usage = raw.message?.usage;
  if (!usage) return 0;
  return [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ].reduce<number>((sum, value) => sum + (typeof value === "number" && value > 0 ? value : 0), 0);
}

export function parseLines(lines: string[]): Turn[] {
  const out: Turn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: Raw;
    try {
      raw = JSON.parse(line) as Raw;
    } catch {
      continue;
    }
    const turn = parseOne(raw);
    if (turn) {
      out.push(turn);
      continue;
    }
    const tokens = usageTokens(raw);
    const pending = out[out.length - 1];
    if (pending && tokens > 0) pending.usageTokens = (pending.usageTokens ?? 0) + tokens;
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
  assistant?: Assistant;
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
        const common = { ts: raw.timestamp ?? "", sessionId: raw.sessionId ?? "?", assistant: "claude-code" as const };
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
      assistant: "claude-code",
    });
  }
  return out;
}

export async function parseDialogueFile(path: string): Promise<DialogueTurn[]> {
  const content = await readFile(path, "utf8");
  return parseDialogueLines(content.split(/\r?\n/));
}
