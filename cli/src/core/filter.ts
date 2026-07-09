import type { Turn } from "./types.js";

// Anchored at the start so a genuine prompt that merely *mentions* one of these
// wrappers ("why did the task-notification fire twice?") is still mined.
const INJECTED_PATTERNS: RegExp[] = [
  /^<command-(name|message|args)/i,
  /<system-reminder>/i,
  /local-command-stdout/i,
  /^Base directory for/i,
  /^Caveat:/i,
  /^<local-command-caveat>/i, // the /^Caveat:/ anchor misses these — the tag comes first
  /^<task-notification>/i,
  /^\[Request interrupted/i,
];

export function isInjected(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return INJECTED_PATTERNS.some(re => re.test(t));
}

export function filterPrompts(turns: Turn[]): Turn[] {
  return turns.filter(t => t.role === "user" && t.text !== undefined && !isInjected(t.text));
}
