import { createHash } from "node:crypto";
import type { Assistant, Suggestion } from "./types.js";
import type { ChainFinding } from "./sequence.js";
import { redact, sanitizeName } from "./security.js";
import { isNudge } from "./playbook.js";
import { estMinutesSavedPerMonth, meanLength } from "./leverage.js";
import { spanDays } from "./temporal.js";

/** Evidence floor for suggesting anything into the committed file: strong,
 * repeated, multi-session repo-local habit — not a one-off. */
export const PROJECT_MIN_COUNT = 3;
export const PROJECT_MIN_SESSIONS = 2;

const CONSTRAINT_RE = /^(never|don't|do not|always|avoid|only|must|stop)\b/i;

export function isConstraintShaped(text: string): boolean {
  return CONSTRAINT_RE.test(text.trim());
}

function suggestionId(seed: string): string {
  return createHash("sha256").update(`project-playbook:${seed}`).digest("hex").slice(0, 12);
}

function oneLine(text: string): string {
  return redact(text)
    .replaceAll("<!--", "[comment removed]")
    .replaceAll("-->", "[comment removed]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 480);
}

function safeSourceSignatures(values: string[]): string[] {
  return [...new Set(values.map(oneLine).filter(Boolean))].sort().slice(0, 100);
}

export function chainWorkflowSuggestion(
  chain: ChainFinding,
  assistantBySession: ReadonlyMap<string, Assistant>,
): Suggestion | null {
  if (chain.count < PROJECT_MIN_COUNT || chain.sessions < PROJECT_MIN_SESSIONS) return null;
  const [first, second, third] = chain.steps.map(step => oneLine(step).slice(0, 120));
  if (!first || !second) return null;
  const text = oneLine(
    `After "${first}", the typical next step is "${second}"${third ? ` then "${third}"` : ""}.`,
  );
  const pooled = [...new Set(chain.sessionIds.map(id => assistantBySession.get(id) ?? "claude-code"))]
    .sort((a, b) => a === b ? 0 : a === "claude-code" ? -1 : 1);
  const sourceSignatures = safeSourceSignatures(chain.steps);
  return {
    id: suggestionId(`workflow:${sourceSignatures.join("→")}`),
    name: sanitizeName(`pb-after-${first}`),
    title: `Repo workflow: ${first} → ${second}`.slice(0, 200),
    rationale:
      `This sequence recurs in this repo (${chain.count}× across ${chain.sessions} sessions); ` +
      "committing it lets every approving teammate's judge know the typical next step.",
    evidence: {
      count: chain.count,
      sessions: chain.sessions,
      assistants: pooled,
      estMinutesSavedPerMonth: estMinutesSavedPerMonth({
        count: chain.count,
        chars: meanLength(sourceSignatures),
        spanDays: spanDays(chain.occurrences),
        kind: "command",
      }),
    },
    confidence: "inferred",
    sourceSignatures,
    payload: { type: "project-playbook", section: "workflows", text },
  };
}

export function nudgeRuleSuggestion(s: Suggestion): Suggestion | null {
  if (!isNudge(s) || s.payload.type !== "loop") return null;
  if (s.evidence.count < PROJECT_MIN_COUNT || s.evidence.sessions < PROJECT_MIN_SESSIONS) return null;
  const text = oneLine(s.payload.instruction);
  if (!isConstraintShaped(text)) return null;
  const sourceSignatures = safeSourceSignatures(s.sourceSignatures?.length ? s.sourceSignatures : [text]);
  return {
    id: suggestionId(`rule:${text}`),
    name: sanitizeName(`pb-rule-${text.slice(0, 24)}`),
    title: `Repo rule: ${text}`.slice(0, 200),
    rationale:
      `You repeat this constraint in this repo (${s.evidence.count}× across ${s.evidence.sessions} sessions); ` +
      "committing it lets every approving teammate's judge stand down accordingly.",
    evidence: {
      ...s.evidence,
      estMinutesSavedPerMonth: s.evidence.estMinutesSavedPerMonth ?? estMinutesSavedPerMonth({
        count: s.evidence.count,
        chars: text.length,
        spanDays: s.evidence.temporal?.spanDays ?? 0,
        kind: "rule",
      }),
    },
    confidence: "inferred",
    sourceSignatures,
    payload: { type: "project-playbook", section: "rules", text },
  };
}

/** Both sources, deduped by derived id. Pure — scan wires it in. */
export function mineProjectPlaybook(
  suggestions: Suggestion[],
  chains: ChainFinding[],
  assistantBySession: ReadonlyMap<string, Assistant>,
): Suggestion[] {
  const out = new Map<string, Suggestion>();
  for (const chain of chains) {
    const s = chainWorkflowSuggestion(chain, assistantBySession);
    if (s) out.set(s.id, s);
  }
  for (const s of suggestions) {
    const rule = nudgeRuleSuggestion(s);
    if (rule) out.set(rule.id, rule);
  }
  return [...out.values()];
}
