import { createHash } from "node:crypto";
import type { Candidate, Suggestion, Confidence } from "./types.js";
import { sanitizeName, redact } from "./security.js";
import type { LLMBackend } from "../llm/backend.js";

const ALLOWED_CONFIDENCE = new Set(["high", "inferred", "flagged"]);

function idFor(signature: string): string {
  return createHash("sha1").update(signature).digest("hex").slice(0, 10);
}

export function candidateToCommand(c: Candidate): Suggestion {
  const words = c.signature.split(" ").slice(0, 3).join(" ");
  const commandName = sanitizeName(words);
  return {
    id: idFor(c.signature),
    name: commandName,
    title: `Reusable command for "${c.signature}"`,
    rationale: `Repeated ${c.count}× across ${c.sessions} sessions.`,
    evidence: { count: c.count, sessions: c.sessions },
    confidence: c.confidence,
    payload: { type: "command", commandName, body: c.examples[0] ?? c.signature },
  };
}

function degradeToCommands(cands: Candidate[]): Suggestion[] {
  return cands.filter(c => c.confidence === "high").map(candidateToCommand);
}

export function buildDetectPrompt(cands: Candidate[]): { system: string; prompt: string } {
  const system =
    "You convert clusters of a developer's repeated Claude Code prompts into reusable artifacts. " +
    "For each cluster decide a type: 'command' (a repeated instruction → slash command), " +
    "'loop' (a recurring cadence task), or 'hook' (an automation tied to a Claude Code lifecycle event; " +
    "the only supported hook event is PreCompact backed by the gradient subcommand 'checkpoint'). " +
    "Echo back the cluster's exact 'signature' as 'sourceSignature' on each suggestion so it can be traced. " +
    "Respond ONLY with JSON: {\"suggestions\":[{sourceSignature,name,title,rationale,confidence,payload}]} where payload is one of " +
    "{type:'command',commandName,body} | {type:'loop',instruction,cadence?} | {type:'hook',event:'PreCompact',subcommand:'checkpoint',description}. " +
    "confidence must be exactly one of \"high\", \"inferred\", or \"flagged\".";
  // Redact secrets from examples/signatures before they ever leave the machine (spec §7).
  const prompt = JSON.stringify(
    cands.map(c => ({
      signature: redact(c.signature),
      count: c.count,
      sessions: c.sessions,
      examples: c.examples.map(redact),
      confidence: c.confidence,
    })),
    null, 2,
  );
  return { system, prompt };
}

interface LlmSuggestion {
  sourceSignature?: string;
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
    const bySignature = new Map(top.map(c => [redact(c.signature), c]));
    return (parsed.suggestions ?? [])
      .filter(s => !!s && !!s.payload && typeof s.payload.type === "string")
      .map(s => {
        const ev = s.sourceSignature ? bySignature.get(s.sourceSignature) : undefined;
        return {
          id: idFor(s.payload.type === "command" ? (s.payload.commandName ?? s.name) : s.name),
          name: s.name,
          title: s.title,
          rationale: s.rationale,
          evidence: { count: ev?.count ?? 0, sessions: ev?.sessions ?? 0 },
          confidence: ALLOWED_CONFIDENCE.has(s.confidence) ? s.confidence : "inferred",
          payload: s.payload,
        };
      });
  } catch {
    // Backend call failed (non-zero exit / network / rate limit) or returned
    // unparseable output — degrade to high-confidence commands rather than crash.
    return degradeToCommands(top);
  }
}
