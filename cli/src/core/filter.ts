import type { Turn, Candidate } from "./types.js";

// Anchored at the start so a genuine prompt that merely *mentions* one of these
// wrappers ("why did the task-notification fire twice?") is still mined.
const INJECTED_PATTERNS: RegExp[] = [
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
  // Defensive fallback for Claude command wrapper fragments. A valid
  // <command-name> envelope is consumed by parseTranscript; message/args-only
  // fragments and older cached parser output must still never be mined.
  /^<command-(?:message|args)>/i,
  /^\[Request interrupted/i,
  // Harness-scheduled autonomous-loop wakeups arrive in the user role but are
  // machine text, not habits: match the resolved tick/check headers and the
  // raw scheduling sentinels.
  /^# autonomous loop (check|tick)\b/i,
  /^<<autonomous-loop(-dynamic)?>>$/,
  // A prompt that is only a slash-command invocation is already automation;
  // mining it would suggest a skill that duplicates the command itself.
  /^\/[\w:-]+$/,
  // Feature-instruction blocks the harness injects when a capability connects
  // mid-session (observed: Claude-in-Chrome browser automation guidelines).
  /^# claude in chrome browser automation\b/i,
];

export type PromptClass = "human" | "injected" | "continuation" | "notification";

const CONTINUATION_RE = /^this session is being continued from a previous/i;
const NOTIFICATION_RE = /^<task-notification>/i;

/** Linear scanner for one or more pasted-image placeholders. Keeping this out
 * of a nested-quantifier regexp avoids attacker-controlled transcript text
 * triggering catastrophic backtracking. */
function isOnlyImagePlaceholders(text: string): boolean {
  let index = 0;
  let count = 0;
  const skipWhitespace = (): void => {
    while (index < text.length && /\s/u.test(text[index])) index += 1;
  };

  skipWhitespace();
  while (index < text.length) {
    if (text.slice(index, index + 6).toLowerCase() !== "[image") return false;
    index += 6;
    if (text[index] === ":") {
      index += 1;
    } else {
      if (text[index] !== " " || text[index + 1] !== "#") return false;
      index += 2;
      const digitsStart = index;
      while (index < text.length && text[index] >= "0" && text[index] <= "9") index += 1;
      if (index === digitsStart || text[index] !== ":") return false;
      index += 1;
    }
    const close = text.indexOf("]", index);
    if (close === -1) return false;
    index = close + 1;
    count += 1;
    skipWhitespace();
  }
  return count > 0;
}

export function isInjected(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  return isOnlyImagePlaceholders(t) || INJECTED_PATTERNS.some(re => re.test(t));
}

export function compileIgnorePatterns(raw?: string[]): RegExp[] {
  if (!Array.isArray(raw)) return [];
  const out: RegExp[] = [];
  for (const src of raw.slice(0, 20)) {
    if (
      typeof src !== "string" ||
      src.length === 0 ||
      src.length > 200 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(src) ||
      // Keep user-supplied patterns in a deliberately small, linear-looking
      // subset. Grouping, alternation, lookarounds, backreferences, and general
      // quantifiers can trigger catastrophic backtracking in JavaScript's
      // RegExp engine on transcript-sized strings.
      /[(){}+?|]/.test(src) ||
      /(^|[^.])\*/.test(src) ||
      (src.match(/\.\*/g)?.length ?? 0) > 1
    ) continue;
    try { out.push(new RegExp(src, "i")); } catch { /* invalid pattern — skip */ }
  }
  return out;
}

export function classifyPrompt(text: string, ignore: RegExp[] = []): PromptClass {
  const t = text.trim();
  if (!t) return "injected";
  if (CONTINUATION_RE.test(t)) return "continuation";
  if (NOTIFICATION_RE.test(t)) return "notification";
  if (isOnlyImagePlaceholders(t) || INJECTED_PATTERNS.some(re => re.test(t))) return "injected";
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
