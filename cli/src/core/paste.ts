import type { Turn, Candidate } from "./types.js";

export const PASTE_MIN_CHARS = 400;
export const PASTE_MIN_COUNT = 3;
export const PASTE_KEY_CHARS = 80;

const ERROR_MARKERS = /error|exception|failed|fatal|traceback|cannot find|undefined is not|command not found/i;

function isCommandOrErrorHead(head: string): boolean {
  if (ERROR_MARKERS.test(head)) return true;
  if (/[.!?]$/.test(head)) return false;
  const command = head.replace(/^[>$]\s+/, "");
  return (
    /^[A-Za-z]:\\/.test(command) ||
    /^[A-Z_][A-Z0-9_]*=/.test(command) ||
    /^(?:\.{0,2}\/|~\/|[a-z0-9][\w@.+:/-]*)(?:\s|$)/.test(command)
  );
}

/** Return the short command/header that identifies a long error-like paste. */
export function extractPasteKey(text: string): string | null {
  if (text.length <= PASTE_MIN_CHARS || !ERROR_MARKERS.test(text)) return null;
  const first = text.split("\n").find(line => line.trim().length > 0);
  if (!first) return null;
  const head = first.trim();
  return isCommandOrErrorHead(head) ? head.slice(0, PASTE_KEY_CHARS) : null;
}

/** Group repeated error pastes without retaining their potentially sensitive bodies. */
export function detectPasteCandidates(prompts: Turn[]): Candidate[] {
  const groups = new Map<string, { count: number; sessions: Set<string>; assistants: Set<"claude-code" | "codex"> }>();
  for (const prompt of prompts) {
    if (prompt.role !== "user" || !prompt.text) continue;
    const key = extractPasteKey(prompt.text);
    if (!key) continue;
    const group = groups.get(key) ?? {
      count: 0,
      sessions: new Set<string>(),
      assistants: new Set<"claude-code" | "codex">(),
    };
    group.count++;
    group.sessions.add(prompt.sessionId);
    group.assistants.add(prompt.assistant ?? "claude-code");
    groups.set(key, group);
  }

  const candidates: Candidate[] = [];
  for (const [key, group] of groups) {
    if (group.count < PASTE_MIN_COUNT) continue;
    candidates.push({
      kind: "paste",
      signature: key,
      examples: [`pasted output of: ${key}`],
      count: group.count,
      sessions: group.sessions.size,
      sessionIds: [...group.sessions],
      confidence: "high",
      assistants: [...group.assistants],
    });
  }
  return candidates.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}
