import { createHash } from "node:crypto";
import type { Candidate, Suggestion, Confidence } from "./types.js";
import { sanitizeName, redact } from "./security.js";
import type { LLMBackend } from "../llm/backend.js";

const ALLOWED_CONFIDENCE = new Set(["high", "inferred", "flagged"]);
const OUTBOUND_FIELD_CAP = 1_000;
const BODY_CAP = 8_000;

function bounded(text: string, cap = OUTBOUND_FIELD_CAP): string {
  return redact(text).slice(0, cap);
}

function idFor(signature: string): string {
  return createHash("sha1").update(signature).digest("hex").slice(0, 10);
}

export function candidateToCommand(c: Candidate): Suggestion {
  const safeSignature = bounded(c.signature);
  const safeExamples = c.examples.map(example => bounded(example, BODY_CAP)).slice(0, 5);
  const words = safeSignature.split(" ").slice(0, 3).join(" ");
  const commandName = sanitizeName(words);
  return {
    id: idFor(c.signature),
    name: commandName,
    title: `Reusable command for "${safeSignature}"`,
    rationale: `Repeated ${c.count}× across ${c.sessions} sessions.`,
    evidence: { count: c.count, sessions: c.sessions },
    confidence: c.confidence,
    examples: safeExamples,
    payload: {
      type: "command",
      commandName,
      body: safeExamples[0] ?? safeSignature,
      triggers: [safeSignature],
    },
  };
}

function degradeToCommands(cands: Candidate[]): Suggestion[] {
  return cands.filter(c => c.confidence === "high").map(candidateToCommand);
}

export function buildDetectPrompt(cands: Candidate[]): { system: string; prompt: string } {
  const system =
    "You convert clusters of a developer's repeated Claude Code prompts into reusable artifacts. " +
    "For each cluster decide a type: 'command' (a repeated instruction → emitted as a reusable Claude Code skill), " +
    "'loop' (a recurring cadence task), or 'hook' (an automation tied to a Claude Code lifecycle event; " +
    "the only supported hook event is PreCompact backed by the gradient subcommand 'checkpoint'). " +
    "Merge clusters that mean the same thing (e.g. 'lgtm' and 'looks good') into ONE suggestion. " +
    "Echo back EVERY merged cluster's exact 'signature' in a 'sourceSignatures' string array so evidence can be summed. " +
    "For command payloads include triggers: the distinct short phrasings the user actually typed, taken from every merged cluster's signature (e.g. [\"lgtm\",\"looks good\"]). " +
    "Respond ONLY with JSON: {\"suggestions\":[{sourceSignatures,name,title,rationale,confidence,payload}]} where payload is one of " +
    "{type:'command',commandName,body,triggers?} | {type:'loop',instruction,cadence?} | {type:'hook',event:'PreCompact',subcommand:'checkpoint',description}. " +
    "confidence must be exactly one of \"high\", \"inferred\", or \"flagged\".";
  // Redact secrets from examples/signatures before they ever leave the machine (spec §7).
  const prompt = JSON.stringify(
    cands.map(c => ({
      signature: bounded(c.signature),
      count: c.count,
      sessions: c.sessions,
      examples: c.examples.slice(0, 5).map(example => bounded(example)),
      confidence: c.confidence,
    })),
    null, 2,
  );
  return { system, prompt };
}

interface LlmSuggestion {
  sourceSignatures?: string[];
  sourceSignature?: string;   // legacy single form still tolerated
  name: string; title: string; rationale: string; confidence: Confidence;
  payload: Suggestion["payload"];
}

export async function detect(
  cands: Candidate[],
  llm: LLMBackend | null,
  opts: { limit?: number; onCap?: (dropped: number) => void } = {},
): Promise<Suggestion[]> {
  const limit = opts.limit ?? 12;
  const ranked = [...cands].sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, limit);
  if (ranked.length > limit) opts.onCap?.(ranked.length - limit);

  if (!llm) {
    return degradeToCommands(top);
  }

  const { system, prompt } = buildDetectPrompt(top);
  try {
    const raw = await llm.complete({ system, prompt });
    const parsed = JSON.parse(raw) as { suggestions?: LlmSuggestion[] };
    const bySignature = new Map(top.map(c => [bounded(c.signature), c]));
    return (parsed.suggestions ?? [])
      .filter(s => !!s && typeof s.name === "string" && typeof s.title === "string" &&
        typeof s.rationale === "string" && !!s.payload && typeof s.payload.type === "string")
      .flatMap(s => {
        const sigs = Array.isArray(s.sourceSignatures)
          ? s.sourceSignatures.filter((sig): sig is string => typeof sig === "string")
          : typeof s.sourceSignature === "string" ? [s.sourceSignature] : [];
        const matched = [...new Set(
          sigs.map(sig => bySignature.get(bounded(sig))).filter((c): c is Candidate => !!c),
        )];
        // Model output is untrusted. It may classify/merge only candidates that
        // were actually supplied; zero-provenance "ghost" artifacts are dropped.
        if (matched.length === 0) return [];
        const count = matched.reduce((n, c) => n + c.count, 0);
        const sessions = new Set(matched.flatMap(c => c.sessionIds)).size;
        const examples = matched.flatMap(c => c.examples).map(example => bounded(example, BODY_CAP)).slice(0, 5);
        const triggers = matched.map(c => bounded(c.signature)).filter(Boolean);
        const firstInstruction = examples[0] ?? triggers[0];
        if (!firstInstruction) return [];

        let payload: Suggestion["payload"];
        if (s.payload.type === "command") {
          payload = {
            type: "command",
            commandName: sanitizeName(s.payload.commandName ?? s.name),
            body: firstInstruction,
            triggers,
          };
        } else if (s.payload.type === "loop") {
          payload = {
            type: "loop",
            instruction: firstInstruction,
            ...(typeof s.payload.cadence === "string" ? { cadence: bounded(s.payload.cadence, 100) } : {}),
          };
        } else if (s.payload.type === "hook") {
          payload = {
            type: "hook",
            event: s.payload.event,
            subcommand: s.payload.subcommand,
            description: bounded(s.payload.description ?? s.title),
          };
        } else {
          return [];
        }

        return [{
          id: idFor(s.payload.type === "command" ? (s.payload.commandName ?? s.name) : s.name),
          name: sanitizeName(s.name),
          title: bounded(s.title, 500),
          rationale: bounded(s.rationale, 2_000),
          evidence: { count, sessions },
          confidence: ALLOWED_CONFIDENCE.has(s.confidence) ? s.confidence : "inferred",
          examples,
          payload,
        }];
      });
  } catch {
    // Backend call failed (non-zero exit / network / rate limit) or returned
    // unparseable output — degrade to high-confidence commands rather than crash.
    return degradeToCommands(top);
  }
}
