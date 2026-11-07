import { open } from "node:fs/promises";
import { constants } from "node:fs";

// The autopilot judge's view of a session: a compact, capped rendering of the
// transcript's last turns, plus a tool-activity fingerprint for the progress
// gate. Deliberately separate from parse.ts, whose user-prompts-only contract
// serves the mining pipeline.

export const TAIL_MAX_TURNS = 30;
export const TAIL_MAX_CHARS = 8000;
export const TAIL_READ_MAX_BYTES = 1_000_000;

interface RawBlock { type?: string; text?: string; name?: string }
interface RawLine {
  type?: string;
  isSidechain?: boolean;
  /** Set by Claude Code on the synthetic message it writes for a failed request. */
  isApiErrorMessage?: boolean;
  error?: string;
  message?: { role?: string; model?: string; content?: string | RawBlock[] };
}

function parseLine(line: string): RawLine | null {
  try {
    return JSON.parse(line) as RawLine;
  } catch {
    return null;
  }
}

function summarizeTools(tools: RawBlock[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name ?? "?", (counts.get(t.name ?? "?") ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
}

/** How the session's assistant side ended: the text of its last real message,
 *  and whether Claude Code recorded the turn after it as a failed request.
 *  The failure is read from Claude Code's own marker (`isApiErrorMessage` on a
 *  `<synthetic>` message), never from wording a model could write. */
export function lastAssistantTurn(lines: string[]): { text: string; apiError?: string } {
  let apiError: string | undefined;
  let sawRealMessage = false;
  let text = "";
  for (let index = lines.length - 1; index >= 0; index--) {
    const raw = parseLine(lines[index]);
    if (!raw || raw.isSidechain || raw.type !== "assistant") continue;
    if (raw.isApiErrorMessage === true && raw.message?.model === "<synthetic>") {
      // Only the failure that ended the session counts.
      if (!sawRealMessage && apiError === undefined) apiError = typeof raw.error === "string" ? raw.error : "unknown";
      continue;
    }
    sawRealMessage = true;
    const content = raw.message?.content;
    if (!Array.isArray(content)) continue;
    text = content.filter(b => b.type === "text").map(b => b.text ?? "").join(" ").trim();
    if (text) break;
  }
  return apiError === undefined ? { text } : { text, apiError };
}

export function renderTail(
  lines: string[],
  opts: { maxTurns?: number; maxChars?: number } = {},
): string {
  const maxTurns = opts.maxTurns ?? TAIL_MAX_TURNS;
  const maxChars = opts.maxChars ?? TAIL_MAX_CHARS;
  const turns: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const raw = parseLine(line);
    if (!raw || raw.isSidechain) continue;
    const content = raw.message?.content;
    if (raw.type === "user") {
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content.filter(b => b.type === "text").map(b => b.text ?? "").join(" ");
      }
      if (text.trim()) turns.push(`user: ${text.trim()}`);
    } else if (raw.type === "assistant" && Array.isArray(content)) {
      const text = content.filter(b => b.type === "text").map(b => b.text ?? "").join(" ").trim();
      const tools = content.filter(b => b.type === "tool_use");
      const toolNote = tools.length
        ? `${text ? " " : ""}[${tools.length} tool call${tools.length === 1 ? "" : "s"}: ${summarizeTools(tools)}]`
        : "";
      if (text || toolNote) turns.push(`assistant: ${text}${toolNote}`);
    }
  }
  const joined = turns.slice(-maxTurns).join("\n");
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/**
 * Progress fingerprint: tool activity ONLY. Text always grows between stops
 * (every reply adds lines), so any text/line component would make "no
 * progress" undetectable. No new tool calls since our last nudge = no real
 * work = stand down (spec §3.2).
 */
export function fingerprint(lines: string[]): string {
  let toolUses = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const raw = parseLine(line);
    if (!raw || raw.isSidechain || raw.type !== "assistant") continue;
    const content = raw.message?.content;
    if (Array.isArray(content)) for (const b of content) if (b.type === "tool_use") toolUses++;
  }
  return `tools:${toolUses}`;
}

export async function readTranscriptLines(path: string): Promise<string[]> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("refusing non-regular transcript");
    const size = metadata.size;
    const start = Math.max(0, size - TAIL_READ_MAX_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    return text.split(/\r?\n/);
  } finally {
    await handle.close();
  }
}
