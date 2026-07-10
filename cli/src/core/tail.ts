import { open, stat } from "node:fs/promises";

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
  message?: { role?: string; content?: string | RawBlock[] };
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
  const size = (await stat(path)).size;
  const start = Math.max(0, size - TAIL_READ_MAX_BYTES);
  const length = size - start;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    return text.split(/\r?\n/);
  } finally {
    await handle.close();
  }
}
