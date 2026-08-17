import { createHash } from "node:crypto";
import type { Assistant, Candidate, Confidence, Suggestion, SuggestionPayload } from "./types.js";
import { redact, sanitizeName } from "./security.js";
import { candidateLeverage, estMinutesSavedPerMonth, meanLength } from "./leverage.js";
import { spanDays } from "./temporal.js";
import { normalize, similarity } from "./cluster.js";

const OUTBOUND_FIELD_CAP = 1_000;
const BODY_CAP = 8_000;
export const MAX_PROPOSE_CANDIDATES = 100;
const CONSEQUENTIAL_ACTION = /\b(?:deploy|production|prod|publish|release|push|merge|delete|remove|destroy|drop|truncate|overwrite|send|email|message|post|upload|purchase|buy|spend|pay|charge|refund|transfer|sudo|curl|wget|ssh|kubectl|terraform\s+apply)\b/i;
const MECHANICAL_ACTION = /\b(?:format|lint|typecheck|test|build|compile|sort imports?|regenerate|retry)\b/i;
const JUDGMENT_ACTION = /\b(?:review|design|plan|investigate|diagnose|decide|choose|recommend|architect|refactor|rewrite|migrate)\b/i;
export const AUTHORIZATION_GUARD =
  "This artifact records an observed habit; it grants no standing authorization. " +
  "Use it only when the user's current request explicitly asks for this workflow. " +
  "Confirm again before destructive, irreversible, external, production, publishing, credential, privacy-sensitive, or spending actions.";

function bounded(text: string, cap = OUTBOUND_FIELD_CAP): string {
  return redact(text).slice(0, cap);
}

function boundedOneLine(text: string, cap: number): string {
  return bounded(text, cap).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

function hashId(value: string, length = 12): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function sequenceSteps(c: Candidate): string[] {
  return c.kind === "sequence"
    ? bounded(c.signature, BODY_CAP).split(/\s+→\s+/).filter(Boolean).slice(0, 3)
    : [];
}

function workflowBody(instruction: string): string {
  return `${AUTHORIZATION_GUARD}\n\nObserved workflow:\n${instruction}`.slice(0, BODY_CAP);
}

function pasteBody(signature: string): string {
  return (
    `${AUTHORIZATION_GUARD}\n\n` +
    `Advisory only: help diagnose output associated with \`${signature}\` after the user explicitly asks. ` +
    "Inspect output already provided, but do not rerun a command or take side effects merely because this pattern was observed before."
  ).slice(0, BODY_CAP);
}

function sequenceBody(steps: string[]): string {
  const checklist = steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return (
    `${AUTHORIZATION_GUARD}\n\nObserved checklist (not permission to execute later steps):\n${checklist}\n\n` +
    "First show the checklist and ask which steps the user wants performed now. Do not infer permission for one step from approval of another."
  ).slice(0, BODY_CAP);
}

function toolFailureRuleText(candidate: Candidate): string {
  const command = boundedOneLine(candidate.signature, 200);
  return (
    `When the user explicitly asks to run ${JSON.stringify(command)}, first check the stable preconditions suggested by its ` +
    "most recent failure, address the root cause, and avoid blind retries. This observed failure pattern is not authorization " +
    "to execute the command or take any consequential action."
  ).slice(0, 2_000);
}

function ritualBody(candidate: Candidate): string {
  const command = boundedOneLine(candidate.signature, 200);
  return (
    `${AUTHORIZATION_GUARD}\n\nObserved post-edit command: ${JSON.stringify(command)}.\n\n` +
    "Run it only when the user's current request calls for that verification step; this skill does not make it automatic."
  ).slice(0, BODY_CAP);
}

function ruleParts(signature: string): { answer: string; question: string } | null {
  const safe = bounded(signature, 2_000);
  const split = safe.indexOf(" ← ");
  if (split <= 0) return null;
  const answer = safe.slice(0, split).trim();
  const question = safe.slice(split + 3).trim();
  return answer && question ? { answer, question } : null;
}

const RULE_AUTHORIZATION_TAIL =
  "This preference is not authorization: ask again before commands, file or state changes, " +
  "external communication, production or publishing actions, deletion, spending, credential use, or data disclosure.";

function ruleText(signature: string): string | null {
  const parts = ruleParts(signature);
  if (!parts) return null;
  return (
    `For low-impact formatting, style, or tool-preference questions similar to ${JSON.stringify(parts.question)}, ` +
    `prefer ${JSON.stringify(parts.answer)}. ${RULE_AUTHORIZATION_TAIL}`
  ).slice(0, 2_000);
}

/** Correction candidates have no `answer ← question` split for ruleText's
 * signature parsing (they're unprompted pushback, not answers to a question),
 * so their local rule text is a fixed template quoting the redacted signature
 * instead, plus the same authorization tail every other rule payload gets. */
function correctionRuleText(signature: string): string {
  const safe = bounded(signature, 2_000);
  return (
    `Repeated correction observed: ${JSON.stringify(safe)}. Follow this preference for low-impact choices. ` +
    RULE_AUTHORIZATION_TAIL
  ).slice(0, 2_000);
}

function deterministicTitle(c: Candidate): string {
  // Titles are one-line display labels; the full signature stays available
  // through evidence examples and triggers.
  const signature = boundedOneLine(c.signature, 120);
  if (c.kind === "paste") return `Advisory troubleshooting guide for “${signature}”`;
  if (c.kind === "sequence") return `Observed workflow checklist: ${signature}`;
  // A failure guide and a post-edit ritual are counted from tool invocations,
  // not from anything the user asked for. Calling either a "reusable workflow"
  // told the reader to look for a request that was never made.
  if (c.kind === "toolfail") return `Recurring failure guide for “${signature}”`;
  if (c.kind === "ritual") return `Observed post-edit step: ${signature}`;
  return `Reusable workflow for “${signature}”`;
}

function evidenceAssistants(candidates: Candidate[]): Assistant[] {
  return [...new Set(candidates.flatMap(candidate => candidate.assistants ?? []))]
    .sort((a, b) => a === b ? 0 : a === "claude-code" ? -1 : 1);
}

/** Redacted union of matched candidates' memberSignatures (fallback to the
 * candidate's own signature when it has none — non-cluster producers like
 * paste/answer/sequence leave memberSignatures empty). This is the stable
 * basis for both `Suggestion.id` (via idFor) and `Suggestion.sourceSignatures`:
 * it never folds in rank index or sessionIds, so it doesn't change when the
 * corpus grows or candidates are scanned in a different order. */
function sourceSignaturesFor(matched: Candidate[]): string[] {
  return [...new Set(matched
    .flatMap(candidate => candidate.memberSignatures.length ? candidate.memberSignatures : [candidate.signature])
    .map(signature => boundedOneLine(signature, OUTBOUND_FIELD_CAP))
    .filter(Boolean))]
    .sort()
    .slice(0, 100);
}

/** Stable suggestion id: hashes the sorted, deduped signature union plus the
 * payload type. Deliberately excludes name/rationale/sourceIds — renaming a
 * suggestion or reordering the candidates that produced it never changes its id. */
export function idFor(sigs: string[], payloadType: string): string {
  return hashId(`${[...new Set(sigs)].sort().join("\u0000")}\u0000${payloadType}`);
}

/** Descending by estimated minutes saved per month; a missing estimate (suggestions
 * cached before this field existed) sorts as if it were zero. */
export function byLeverage(a: Suggestion, b: Suggestion): number {
  return (b.evidence.estMinutesSavedPerMonth ?? 0) - (a.evidence.estMinutesSavedPerMonth ?? 0) ||
    b.evidence.count - a.evidence.count ||
    a.name.localeCompare(b.name);
}

/** Candidate kinds counted from tool invocations rather than read out of prompt
 * text. A suggestion sourced from one of these is a measurement; everything
 * else is an interpretation of what repeated phrasing meant. */
const TOOL_EVENT_KINDS: ReadonlySet<Candidate["kind"]> = new Set(["toolfail", "ritual"]);

function evidenceFor(matched: Candidate[], payloadType: SuggestionPayload["type"]): Suggestion["evidence"] {
  if (matched.length === 0) throw new Error("cannot derive evidence without a source candidate");
  const count = matched.reduce((n, c) => n + c.count, 0);
  const sessions = new Set(matched.flatMap(c => c.sessionIds)).size;
  const assistants = evidenceAssistants(matched);
  const highestCount = [...matched].sort((a, b) =>
    b.count - a.count || a.signature.localeCompare(b.signature))[0];
  return {
    count,
    sessions,
    ...(matched.every(candidate => TOOL_EVENT_KINDS.has(candidate.kind)) ? { measured: true } : {}),
    ...(assistants.length ? { assistants } : {}),
    estMinutesSavedPerMonth: estMinutesSavedPerMonth({
      count,
      chars: meanLength(matched.flatMap(c => c.examples)),
      spanDays: spanDays(matched.flatMap(c => c.occurrences)),
      kind: payloadType === "project-playbook" ? "command" : payloadType,
    }),
    ...(highestCount.temporal ? { temporal: highestCount.temporal } : {}),
  };
}

/**
 * Whether a skill body is routine enough to pin to the cheap model.
 *
 * This used to require the model to volunteer a `mechanical: true` flag, which
 * meant the decision was only as reliable as the response that carried it. The
 * three predicates below were always the real test — the flag never had a vote
 * the local checks could not veto — so with the model gone they simply run on
 * their own.
 */
function isLocallyMechanical(candidates: Candidate[], instruction: string): boolean {
  return candidates.every(candidate => candidate.kind === "unknown") &&
    !CONSEQUENTIAL_ACTION.test(instruction) &&
    !JUDGMENT_ACTION.test(instruction) &&
    MECHANICAL_ACTION.test(instruction);
}

/**
 * Tokens that carry no meaning in an artifact name: command flags, filesystem
 * paths, and redaction placeholders. Without this filter a name is derived from
 * whatever the command happened to be pointed at — the dogfood run produced
 * `git-c-redacted-projects-magister-marketi` for `git -C <path> status`, which
 * names the path rather than the habit and burns the whole 40-char budget.
 */
function isNoiseToken(token: string): boolean {
  return token.startsWith("-") || token.includes("/") || token.includes("[REDACTED]");
}

/** Artifact name from the candidate alone. The model used to supply this — it
 * was the only field of a response that ever reached an installed artifact —
 * and three meaningful words of the signature is what it was approximating. */
function slugFor(c: Candidate, seed?: string): string {
  const source = seed ?? sequenceSteps(c)[0] ?? bounded(c.signature);
  const prefix = c.kind === "paste" ? "troubleshoot " : "";
  const words = `${prefix}${source}`.split(/\s+/).filter(Boolean);
  const meaningful = words.filter(word => !isNoiseToken(word));
  // Every token being noise is possible (a bare path); fall back rather than
  // hand sanitizeName an empty string and name every such artifact "untitled".
  return sanitizeName((meaningful.length ? meaningful : words).slice(0, 3).join(" "));
}

export function candidateToCommand(c: Candidate): Suggestion {
  const safeSignature = bounded(c.signature);
  const safeExamples = c.examples.map(example => bounded(example, 2_000)).slice(0, 5);
  const steps = sequenceSteps(c);
  const trigger = steps[0] ?? safeSignature;
  const commandName = slugFor(c);
  const instruction = safeExamples[0] ?? safeSignature;
  const sourceSignatures = sourceSignaturesFor([c]);
  const body = c.kind === "paste"
    ? pasteBody(safeSignature)
    : c.kind === "sequence"
      ? sequenceBody(steps)
      : c.kind === "ritual"
        ? ritualBody(c)
        : workflowBody(instruction);
  return {
    id: idFor(sourceSignatures, "command"),
    name: commandName,
    title: deterministicTitle(c),
    rationale: `Observed ${c.count}× across ${c.sessions} sessions; review is required before installation.`,
    evidence: evidenceFor([c], "command"),
    confidence: c.confidence,
    examples: safeExamples,
    sourceSignatures,
    payload: {
      type: "command",
      commandName,
      body,
      triggers: c.kind === "paste"
        ? [`help with ${safeSignature}`]
        : c.kind === "ritual" ? [boundedOneLine(c.signature, 200)] : [trigger],
      ...(isLocallyMechanical([c], instruction) ? { mechanical: true } : {}),
    },
  };
}

/** Locally reconstructed loop suggestion. The instruction is rebuilt from the
 * candidate the same way candidateToCommand rebuilds a command body: raw
 * examples/signatures are never trusted as authored text. A candidate whose
 * instruction reads as consequential never becomes an unattended loop; it falls
 * back to the same guarded command a non-loop candidate would get. */
export function candidateToLoop(c: Candidate): Suggestion {
  const safeSignature = bounded(c.signature);
  const safeExamples = c.examples.map(example => bounded(example, 2_000)).slice(0, 5);
  const instruction = safeExamples[0] ?? safeSignature;
  if (CONSEQUENTIAL_ACTION.test(instruction)) return candidateToCommand(c);

  const name = slugFor(c, instruction);
  const sourceSignatures = sourceSignaturesFor([c]);
  const evidence = evidenceFor([c], "loop");
  const temporal = c.temporal;
  const rationale = c.cadence && temporal
    ? `Measured ${temporal.distinctDays} active day(s) across a ${temporal.spanDays}-day span; derived ${c.cadence} from the median observed UTC hour. Review is required before use.`
    : temporal
      ? `Measured a longest run of ${temporal.maxRunLength} prompt(s) across ${temporal.runSessions} recurring-run session(s). Review is required before use.`
      : `Observed ${c.count}× across ${c.sessions} sessions; review is required before use.`;
  return {
    id: idFor(sourceSignatures, "loop"),
    name,
    title: deterministicTitle(c),
    rationale,
    evidence,
    confidence: c.confidence,
    examples: safeExamples,
    sourceSignatures,
    payload: {
      type: "loop",
      instruction: `${AUTHORIZATION_GUARD} Reminder: ${instruction}`.slice(0, 2_000),
      ...(c.cadence ? { cadence: bounded(c.cadence, 100) } : {}),
    },
  };
}

/**
 * Standing-instruction suggestion for the three kinds whose value is a rule
 * rather than an invocable artifact.
 *
 * `answer` carries an `answer ← question` signature and yields nothing without
 * it; `correction` is unprompted pushback; `toolfail` is a counted failure
 * loop, where the preventive form is the useful one — a skill the user has to
 * remember to invoke cannot help with a failure they did not see coming.
 */
export function candidateToRule(c: Candidate): Suggestion | null {
  const text = c.kind === "correction"
    ? correctionRuleText(c.signature)
    : c.kind === "toolfail"
      ? toolFailureRuleText(c)
      : ruleText(c.signature);
  if (!text) return null;

  const seed = c.kind === "answer" ? ruleParts(c.signature)?.answer : undefined;
  const ruleName = slugFor(c, seed);
  const sourceSignatures = sourceSignaturesFor([c]);
  const title = c.kind === "toolfail"
    ? `Prevent recurring failure: ${boundedOneLine(c.signature, 120)}`
    : `Observed low-impact preference: ${seed ?? boundedOneLine(c.signature, 120)}`;
  return {
    id: idFor(sourceSignatures, "rule"),
    name: ruleName,
    title: bounded(title, 500),
    rationale: `Observed ${c.count}× across ${c.sessions} sessions; generated content is reconstructed locally.`,
    evidence: evidenceFor([c], "rule"),
    confidence: c.confidence,
    examples: c.examples.map(example => bounded(example, 2_000)).slice(0, 5),
    sourceSignatures,
    payload: { type: "rule", target: "project", ruleName, text },
  };
}

/**
 * A post-edit ritual becomes a hook only when the observed command is a single
 * safe line. Everything else falls back to a command, because a hook runs
 * unattended and an unattended `git push` is not a verification step.
 */
export function candidateToRitualHook(c: Candidate): Suggestion | null {
  const command = boundedOneLine(c.signature, 200);
  if (!command || CONSEQUENTIAL_ACTION.test(command)) return null;
  const sourceSignatures = sourceSignaturesFor([c]);
  return {
    id: idFor(sourceSignatures, "hook"),
    name: slugFor(c),
    title: bounded(deterministicTitle(c), 500),
    rationale: `Observed ${c.count}× across ${c.sessions} sessions; generated content is reconstructed locally.`,
    evidence: evidenceFor([c], "hook"),
    confidence: c.confidence,
    examples: c.examples.map(example => bounded(example, 2_000)).slice(0, 5),
    sourceSignatures,
    payload: {
      type: "hook",
      event: "PostToolUse",
      matcher: "Edit|Write|NotebookEdit",
      command,
      description: "Run the observed command automatically after file edits.",
    },
  };
}

/**
 * The whole of what the model used to decide.
 *
 * A response contributed exactly three fields — a name, a payload type, and a
 * confidence — and every one of them was either rebuilt locally afterwards or
 * clamped by a local check. The payload type it chose is implied by
 * `candidate.kind`, which classify.ts and corrections.ts already assign without
 * a model, so the mapping below is that decision written down.
 */
export function candidateToSuggestion(c: Candidate): Suggestion | null {
  switch (c.kind) {
    case "loop":
      return candidateToLoop(c);
    case "answer":
    case "correction":
    case "toolfail":
      return candidateToRule(c);
    case "ritual":
      return candidateToRitualHook(c) ?? candidateToCommand(c);
    default:
      return candidateToCommand(c);
  }
}

const NEAR_DUPLICATE_THRESHOLD = 0.6;

/** The part of each payload that actually varies between habits, deliberately
 * excluding shared boilerplate (AUTHORIZATION_GUARD / RULE_AUTHORIZATION_TAIL)
 * that every command/loop/rule body carries — comparing full bodies would
 * make near-unrelated suggestions look identical. */
function mergeDistinctiveText(payload: SuggestionPayload): string {
  if (payload.type === "command") {
    return payload.triggers?.length ? payload.triggers.join(" ") : payload.commandName;
  }
  if (payload.type === "loop") {
    return payload.instruction.startsWith(AUTHORIZATION_GUARD)
      ? payload.instruction.slice(AUTHORIZATION_GUARD.length)
      : payload.instruction;
  }
  if (payload.type === "rule") {
    const text = payload.text.endsWith(RULE_AUTHORIZATION_TAIL)
      ? payload.text.slice(0, payload.text.length - RULE_AUTHORIZATION_TAIL.length)
      : payload.text;
    return `${payload.ruleName} ${text}`;
  }
  if (payload.type === "project-playbook") {
    return `${payload.section} ${payload.text}`;
  }
  return payload.description;
}

function canonicalMergeText(value: string): string {
  return normalize(value
    .replace(/\blgtm\b/gi, "looks good")
    .replace(/\blooks good to me\b/gi, "looks good"));
}

/** Distinctive text is the primary signal. A strong name match can reinforce
 * partial text overlap, but name alone never merges unrelated artifacts.
 * The tiny semantic canonicalization covers the observed lgtm/looks-good
 * dogfood synonym without pretending a lexical matcher is a general model. */
function isNearDuplicate(a: Suggestion, b: Suggestion): boolean {
  if (a.payload.type !== b.payload.type) return false;
  const nameSimilarity = similarity(normalize(a.name), normalize(b.name));
  const textSimilarity = similarity(
    canonicalMergeText(mergeDistinctiveText(a.payload)),
    canonicalMergeText(mergeDistinctiveText(b.payload)),
  );
  return textSimilarity >= NEAR_DUPLICATE_THRESHOLD ||
    (nameSimilarity >= 0.75 && textSimilarity >= 0.25);
}

const CONFIDENCE_CAUTION: Record<Confidence, number> = { high: 0, inferred: 1, flagged: 2 };

/** Two clusters can describe one habit in different words — the dogfood case
 * was "lgtm" and "looks good" arriving as separate command suggestions. Hosts
 * are considered in leverage order; a suggestion folds into the first
 * compatible host whose distinctive payload text is lexically equivalent.
 * Unresolvable provenance keeps both outputs; consolidation must never
 * silently drop evidence. */
function sourceCandidates(
  suggestion: Suggestion,
  bySignature: Map<string, Candidate>,
): Candidate[] | null {
  const signatures = suggestion.sourceSignatures ?? [];
  if (signatures.length === 0) return null;
  const candidates = signatures.map(signature => bySignature.get(signature));
  if (!candidates.every((candidate): candidate is Candidate => candidate !== undefined)) return null;
  return [...new Set(candidates)];
}

function sourceSubtype(suggestion: Suggestion, bySignature: Map<string, Candidate>): string {
  if (suggestion.payload.type === "hook") {
    return [
      "hook",
      suggestion.payload.event,
      suggestion.payload.matcher ?? "",
      suggestion.payload.subcommand ?? "",
      suggestion.payload.command ?? "",
    ].join("\u0000");
  }
  if (suggestion.payload.type === "loop") {
    return suggestion.payload.cadence ? "loop:scheduled" : "loop:unscheduled";
  }
  const candidates = sourceCandidates(suggestion, bySignature);
  const kinds = [...new Set((candidates ?? []).map(candidate => candidate.kind))].sort();
  if (suggestion.payload.type === "command") {
    const special = kinds.filter(kind =>
      kind === "paste" || kind === "sequence" || kind === "toolfail" || kind === "ritual");
    return `command:${special.length ? special.join("+") : "plain"}`;
  }
  const special = kinds.filter(kind =>
    kind === "answer" || kind === "correction" || kind === "toolfail");
  return `rule:${special.length ? special.join("+") : "plain"}`;
}

export function mergeNearDuplicates(suggestions: Suggestion[], bySignature: Map<string, Candidate>): Suggestion[] {
  const hosts: Suggestion[] = [];
  for (const suggestion of [...suggestions].sort(byLeverage)) {
    const hostIndex = hosts.findIndex(host =>
      sourceSubtype(host, bySignature) === sourceSubtype(suggestion, bySignature) &&
      isNearDuplicate(host, suggestion));
    if (hostIndex === -1) {
      hosts.push(suggestion);
      continue;
    }

    const host = hosts[hostIndex];
    const unionSignatures = [...new Set([
      ...(host.sourceSignatures ?? []),
      ...(suggestion.sourceSignatures ?? []),
    ])].filter(Boolean).sort();
    if (unionSignatures.length === 0) {
      hosts.push(suggestion);
      continue;
    }
    const resolved = unionSignatures.map(signature => bySignature.get(signature));
    if (!resolved.every((candidate): candidate is Candidate => candidate !== undefined)) {
      hosts.push(suggestion);
      continue;
    }
    const matched = [...new Set(resolved)];

    const unionExamples = [...new Set([...(host.examples ?? []), ...(suggestion.examples ?? [])])].slice(0, 5);
    const evidence = evidenceFor(matched, host.payload.type);
    // Ambiguity survives the merge: confidence is the more cautious of the pair.
    const confidence = CONFIDENCE_CAUTION[suggestion.confidence] > CONFIDENCE_CAUTION[host.confidence]
      ? suggestion.confidence
      : host.confidence;
    hosts[hostIndex] = {
      ...host,
      evidence,
      id: idFor(unionSignatures, host.payload.type),
      sourceSignatures: unionSignatures,
      examples: unionExamples,
      rationale: `Observed ${evidence.count}× across ${evidence.sessions} distinct sessions; generated content is reconstructed locally.`,
      confidence,
    };
  }
  return hosts;
}

export function boundedProposeLimit(value: number | undefined, fallback = 12): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return fallback;
  return Math.min(value as number, MAX_PROPOSE_CANDIDATES);
}

/**
 * Turn mined candidates into reviewable suggestions. Local, deterministic, and
 * total: the same corpus always produces the same artifacts, which is what lets
 * `optimize` run in a hook, on a schedule, and with no network.
 */
export function propose(
  cands: Candidate[],
  opts: { limit?: number; onCap?: (dropped: number) => void } = {},
): Suggestion[] {
  const limit = boundedProposeLimit(opts.limit);
  const ranked = [...cands].sort((a, b) =>
    candidateLeverage(b) - candidateLeverage(a) ||
    b.count - a.count ||
    a.signature.localeCompare(b.signature));
  const top = ranked.slice(0, limit);
  if (ranked.length > limit) opts.onCap?.(ranked.length - limit);

  const bySignature = new Map<string, Candidate>();
  for (const candidate of top) {
    for (const signature of sourceSignaturesFor([candidate])) {
      if (!bySignature.has(signature)) bySignature.set(signature, candidate);
    }
  }

  const out: Suggestion[] = [];
  const names = new Set<string>();
  for (const candidate of top) {
    const suggestion = candidateToSuggestion(candidate);
    if (!suggestion) continue;
    // Names become file paths, so a collision would have one artifact overwrite
    // another. The signature that produced the duplicate is still distinct, so
    // the suffix keeps both rather than dropping one.
    let name = suggestion.name;
    for (let n = 2; names.has(name); n++) name = sanitizeName(`${suggestion.name}-${n}`);
    names.add(name);
    out.push(name === suggestion.name ? suggestion : renamed(suggestion, name));
  }
  return mergeNearDuplicates(out, bySignature).sort(byLeverage);
}

/** A rename has to reach the payload too: commandName and ruleName are what the
 * emitters turn into paths, and leaving them behind would recreate the very
 * collision the suffix exists to avoid. */
function renamed(suggestion: Suggestion, name: string): Suggestion {
  const payload = suggestion.payload.type === "command"
    ? { ...suggestion.payload, commandName: name }
    : suggestion.payload.type === "rule"
      ? { ...suggestion.payload, ruleName: name }
      : suggestion.payload;
  return { ...suggestion, name, payload };
}
