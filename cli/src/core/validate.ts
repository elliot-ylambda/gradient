import type { Suggestion } from "./types.js";
import { sanitizeName, stripUnsafeControls } from "./security.js";

export const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set(["checkpoint", "scan"]);
const TYPES = new Set(["command", "loop", "hook", "rule"]);
const CONFIDENCES = new Set(["high", "inferred", "flagged"]);
const HOOK_EVENTS = new Set(["PreCompact", "SessionStart"]);
const TEXT_CAP = 8_000;

function validText(value: unknown, cap = TEXT_CAP): value is string {
  return typeof value === "string" && value.length <= cap && stripUnsafeControls(value) === value;
}

export function validateSuggestion(x: unknown): asserts x is Suggestion {
  const s = x as Record<string, unknown>;
  if (!s || typeof s !== "object") throw new Error("suggestion is not an object");
  for (const k of ["id", "name", "title", "rationale", "confidence"]) {
    if (!validText(s[k], k === "rationale" ? 2_000 : 500)) throw new Error(`suggestion.${k} must be safe bounded text`);
  }
  if (sanitizeName(s.name as string) !== s.name) throw new Error("suggestion.name must be sanitized");
  if (!CONFIDENCES.has(s.confidence as string)) {
    throw new Error(`invalid confidence: ${String(s.confidence)}`);
  }
  const payload = s.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") throw new Error("suggestion.payload missing");
  if (typeof payload.type !== "string" || !TYPES.has(payload.type)) {
    throw new Error(`invalid payload.type: ${String(payload.type)}`);
  }
  if (payload.type === "command" && typeof payload.commandName !== "string") {
    throw new Error("command payload needs commandName");
  }
  if (payload.type === "command") {
    if (!validText(payload.commandName, 100) || !validText(payload.body)) {
      throw new Error("command payload needs safe bounded commandName + body");
    }
    if (payload.triggers !== undefined) {
      if (!Array.isArray(payload.triggers) || payload.triggers.length > 20 || payload.triggers.some(t => !validText(t, 1_000))) {
        throw new Error("command payload triggers must be an array of strings");
      }
    }
  }
  if (payload.type === "loop") {
    if (!validText(payload.instruction, 2_000) ||
      (payload.cadence !== undefined && !validText(payload.cadence, 100))) {
      throw new Error("loop payload needs a safe bounded instruction");
    }
  }
  if (payload.type === "hook") {
    if (!validText(payload.event, 50) || !validText(payload.subcommand, 50) ||
      !HOOK_EVENTS.has(payload.event) || !KNOWN_SUBCOMMANDS.has(payload.subcommand)) {
      throw new Error("hook payload needs event + subcommand");
    }
    if (payload.description !== undefined && !validText(payload.description, 1_000)) {
      throw new Error("hook description must be safe bounded text");
    }
  }
  const evidence = s.evidence as Record<string, unknown> | undefined;
  if (!evidence || !Number.isInteger(evidence.count) || (evidence.count as number) < 0 ||
    !Number.isInteger(evidence.sessions) || (evidence.sessions as number) < 0) {
    throw new Error("suggestion.evidence must contain non-negative integer counts");
  }
  if (s.examples !== undefined &&
    (!Array.isArray(s.examples) || s.examples.length > 5 || s.examples.some(example => !validText(example, 2_000)))) {
    throw new Error("suggestion.examples must contain safe bounded text");
  }
  if (payload.type === "rule") {
    if (payload.target !== "project" && payload.target !== "user") {
      throw new Error("rule payload target must be project|user");
    }
    if (!validText(payload.ruleName, 100) || sanitizeName(payload.ruleName) !== payload.ruleName) {
      throw new Error("rule payload needs a safe sanitized ruleName");
    }
    if (!validText(payload.text, 2_000) || payload.text.trim().length === 0) {
      throw new Error("rule payload needs safe bounded text");
    }
  }
}

export function assertHookRunnable(s: Suggestion): void {
  if (s.payload.type !== "hook") return;
  if (!KNOWN_SUBCOMMANDS.has(s.payload.subcommand)) {
    throw new Error(`hook references unknown gradient subcommand: ${s.payload.subcommand}`);
  }
}
