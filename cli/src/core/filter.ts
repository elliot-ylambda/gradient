import type { Turn, Candidate } from "./types.js";

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
  /^<environment_context>/i,
  /^<permissions instructions>/i,
  /^<skills_instructions>/i,
  /^<apps_instructions>/i,
  /^<plugins_instructions>/i,
  /^<multi_agent_mode>/i,
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
  if (!t) return "injected";
  if (CONTINUATION_RE.test(t)) return "continuation";
  if (NOTIFICATION_RE.test(t)) return "notification";
  if (INJECTED_PATTERNS.some(re => re.test(t))) return "injected";
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

/** Template floods: long, voluminous, ~once-per-session → machine-injected, not a habit (spec §3 A1). */
export const TEMPLATE_MIN_CHARS = 240;
export const TEMPLATE_MIN_COUNT = 25;

/** Count/session shape shared by lexical floods and long paste-key groups. */
export function hasTemplateFloodSupport(c: Candidate): boolean {
  return c.count >= TEMPLATE_MIN_COUNT && c.sessions >= Math.ceil(c.count * 0.9);
}

export function isTemplateFlood(c: Candidate): boolean {
  return (
    c.signature.length > TEMPLATE_MIN_CHARS &&
    hasTemplateFloodSupport(c)
  );
}
