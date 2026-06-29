import type { Turn } from "./types.js";

const INJECTED_PATTERNS: RegExp[] = [
  /^<command-(name|message|args)/i,
  /<system-reminder>/i,
  /<local-command-stdout/i,
  /local-command-stdout/i,
  /^Base directory for/i,
  /^Caveat:/i,
  /^\[Request interrupted/i,
  /^<[a-z-]+>/i, // any leading xml-ish tag block
];

export function isInjected(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return INJECTED_PATTERNS.some(re => re.test(t));
}

export function filterPrompts(turns: Turn[]): Turn[] {
  return turns.filter(t => t.role === "user" && t.text !== undefined && !isInjected(t.text));
}
