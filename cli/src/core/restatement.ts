import type { Suggestion } from "./types.js";
import { normalize, trigrams } from "./cluster.js";

/**
 * Boilerplate the emitter and the judge add to every generated body. None of it
 * is content the suggestion contributed, so it must not count as substance —
 * otherwise the longest artifact is always the one that says the least.
 */
const SCAFFOLD: readonly RegExp[] = [
  // The standing-authorization preamble every command/loop payload carries.
  /this artifact records an observed habit[\s\S]*?spending actions\./i,
  /observed (?:workflow|checklist)[^:\n]*:/i,
  /\(not permission to execute later steps\)/i,
  /first show the checklist[\s\S]*?approval of another\./i,
  /\breminder:/i,
];

/**
 * What the artifact actually says, once the scaffolding and list punctuation are
 * removed. An empty result means the body was scaffolding all the way down.
 */
export function bodySubstance(text: string): string {
  let out = text;
  for (const pattern of SCAFFOLD) out = out.replace(pattern, " ");
  return normalize(
    out
      .replace(/^[ \t]*\d+[.)][ \t]*/gm, " ")
      .replace(/^[ \t]*[-*][ \t]*/gm, " ")
      .replace(/[`"']/g, " "),
  );
}

/**
 * Fraction of the body's substance that already appears in the prompts it was
 * mined from. 1.0 means the artifact is the user's own sentence handed back.
 */
export function restatementScore(body: string, examples: readonly string[]): number {
  const substance = trigrams(bodySubstance(body));
  if (substance.size === 0) return 1;
  // Normalize per example, not once over the join: trailing punctuation is only
  // stripped at the end of a string, so joining first leaves every example but
  // the last carrying a full stop the body does not have.
  const source = trigrams(examples.map(normalize).join(" "));
  if (source.size === 0) return 0;
  let shared = 0;
  for (const gram of substance) if (source.has(gram)) shared++;
  return shared / substance.size;
}

/**
 * Above this share of borrowed trigrams the artifact contributes no instruction
 * the prompt did not already carry. Calibrated on the dogfood corpus, where the
 * three prompt-derived artifacts scored 0.93–1.00 and the scaffolding-only loop
 * scored 1.00; nothing measured landed between 0.4 and 0.9.
 */
export const RESTATEMENT_THRESHOLD = 0.9;

function restatableText(suggestion: Suggestion): string | null {
  switch (suggestion.payload.type) {
    case "command": return suggestion.payload.body;
    case "loop": return suggestion.payload.instruction;
    // Hooks, rules and playbook entries are not restatements of a prompt: a hook
    // is derived from counted events, and a rule's value is that it is stated
    // somewhere the assistant reads, not that it is novel prose.
    default: return null;
  }
}

/**
 * An artifact that enumerates several steps contributes the composition — that
 * these steps go together, in this order — even when every step is the user's
 * own wording. A single-instruction artifact has nothing left once its wording
 * is borrowed, so only single-instruction bodies are judged here.
 */
function enumeratesSteps(text: string): boolean {
  return (text.match(/^[ \t]*\d+[.)][ \t]+\S/gm) ?? []).length >= 2;
}

/**
 * True when generating this artifact would hand the user back what they typed.
 *
 * A skill costs an invocation and a slot in the model's attention budget; if its
 * body is the prompt with a heading above it, invoking it is strictly worse than
 * typing the prompt. Repetition proves the phrasing recurred, never that an
 * artifact would help — this is the test that separates the two.
 */
export function isRestatement(suggestion: Suggestion): boolean {
  const text = restatableText(suggestion);
  if (text === null || enumeratesSteps(text)) return false;
  const examples = suggestion.examples ?? [];
  if (examples.length === 0) return false;
  return restatementScore(text, examples) >= RESTATEMENT_THRESHOLD;
}
