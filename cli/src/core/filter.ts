import type { Turn } from "../types";

// Claude Code injects a lot of text into the user role that the user never typed:
// hook output, skill loaders, system reminders, slash-command expansions, resume
// summaries. Left in, the engine "discovers" Claude Code's own plumbing — so we
// strip it before clustering. (Spec §1: review-hook ×849, skill-loader ×492.)
const INJECTED_PREFIXES = [
  "Caveat:",
  "[Request interrupted",
  "Base directory for",
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "This session is being continued",
  "Your task is to create a detailed summary",
  "Please continue the conversation from where",
];

const INJECTED_INCLUDES = [
  "<system-reminder>",
  "<command-name>",
  "do not respond to these messages",
  "this is an automated background-task event",
  // review/security hooks inject prompts into the user role — the dominant leak.
  "review this change",
  "review the following",
  "analyze this codebase by following",
  "[image #", // pasted-image placeholders injected by the client
];

// Bare acknowledgements aren't automatable workflows. (Loop signals like
// "continue"/"what's next" are deliberately NOT here — those are real candidates.)
const AFFIRMATIONS = new Set([
  "yes", "y", "yeah", "yep", "ok", "okay", "k", "lgtm", "looks good",
  "nice", "thanks", "thank you", "perfect", "great", "sure", "sounds good", "np",
]);

// Matching is case-insensitive: hooks vary capitalization (e.g. "Review this
// change for security…" must match the "review this change" marker).
const PREFIXES = INJECTED_PREFIXES.map((p) => p.toLowerCase());
const INCLUDES = INJECTED_INCLUDES.map((p) => p.toLowerCase());

function isNoise(text: string): boolean {
  // single chars, bare numbers (menu picks), and pure punctuation aren't workflows.
  if (text.length < 3 || /^[0-9]+$/.test(text) || /^[\p{P}\p{S}]+$/u.test(text)) {
    return true;
  }
  return AFFIRMATIONS.has(text.toLowerCase().replace(/[.!]+$/, "").trim());
}

export type FilterResult = { prompts: Turn[]; removed: number };

/** Turn[] → genuine typed user prompts (injected/system/noise text removed). */
export function filterTurns(turns: Turn[]): FilterResult {
  const prompts: Turn[] = [];
  let removed = 0;

  for (const t of turns) {
    if (t.role !== "user" || t.text === undefined) continue;
    const text = t.text.trim();
    if (!text) {
      removed++;
      continue;
    }
    const lower = text.toLowerCase();
    const injected =
      PREFIXES.some((p) => lower.startsWith(p)) ||
      INCLUDES.some((p) => lower.includes(p));
    if (injected || isNoise(text)) {
      removed++;
      continue;
    }
    prompts.push({ ...t, text });
  }

  return { prompts, removed };
}
