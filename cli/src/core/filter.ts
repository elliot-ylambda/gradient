import type { Turn } from "./types.js";

const INJECTED_PATTERNS: RegExp[] = [
  /^<command-(name|message|args)/i,
  /<system-reminder>/i,
  /local-command-stdout/i,
  /^Base directory for/i,
  /^Caveat:/i,
  /^\[Request interrupted/i,
];

export type PromptClass = "human" | "injected" | "continuation" | "notification";

const CONTINUATION_RE = /^this session is being continued from a previous/i;
const NOTIFICATION_RE = /^<task-notification>/i;

export function isInjected(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return INJECTED_PATTERNS.some(re => re.test(t));
}

export function compileIgnorePatterns(raw?: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of raw ?? []) {
    try { out.push(new RegExp(src, "i")); } catch { /* invalid pattern — skip */ }
  }
  return out;
}

export function classifyPrompt(text: string, ignore: RegExp[] = []): PromptClass {
  const t = text.trim();
  if (!t || INJECTED_PATTERNS.some(re => re.test(t))) return "injected";
  if (CONTINUATION_RE.test(t)) return "continuation";
  if (NOTIFICATION_RE.test(t)) return "notification";
  if (ignore.some(re => re.test(t))) return "injected";
  return "human";
}

export function classifyPrompts(turns: Turn[], ignore: RegExp[] = []): Record<PromptClass, Turn[]> {
  const out: Record<PromptClass, Turn[]> = { human: [], injected: [], continuation: [], notification: [] };
  for (const t of turns) {
    if (t.role !== "user" || t.text === undefined) continue;
    out[classifyPrompt(t.text, ignore)].push(t);
  }
  return out;
}

export function filterPrompts(turns: Turn[], ignore: RegExp[] = []): Turn[] {
  return classifyPrompts(turns, ignore).human;
}
