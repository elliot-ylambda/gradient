import type { Turn, Candidate } from "./types.js";

export const PASTE_MIN_CHARS = 400;
export const PASTE_MIN_COUNT = 3;
export const PASTE_KEY_CHARS = 80;

const ERROR_MARKERS = /error|exception|failed|fatal|traceback|cannot find|undefined is not|command not found/i;

/** Return the short command/header that identifies a long error-like paste. */
export function extractPasteKey(text: string): string | null {
  if (text.length <= PASTE_MIN_CHARS || !ERROR_MARKERS.test(text)) return null;
  const first = text.split("\n").find(line => line.trim().length > 0);
  return first ? first.trim().slice(0, PASTE_KEY_CHARS) : null;
}

/** Group repeated error pastes without retaining their potentially sensitive bodies. */
export function detectPasteCandidates(prompts: Turn[]): Candidate[] {
  const groups = new Map<string, { count: number; sessions: Set<string> }>();
  for (const prompt of prompts) {
    if (prompt.role !== "user" || !prompt.text) continue;
    const key = extractPasteKey(prompt.text);
    if (!key) continue;
    const group = groups.get(key) ?? { count: 0, sessions: new Set<string>() };
    group.count++;
    group.sessions.add(prompt.sessionId);
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
    });
  }
  return candidates.sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
}
