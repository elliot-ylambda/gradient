import type { Suggestion } from "./types.js";

export const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set(["checkpoint", "scan"]);
const TYPES = new Set(["command", "loop", "hook", "rule"]);
const CONFIDENCES = new Set(["high", "inferred", "flagged"]);

export function validateSuggestion(x: unknown): asserts x is Suggestion {
  const s = x as Record<string, unknown>;
  if (!s || typeof s !== "object") throw new Error("suggestion is not an object");
  for (const k of ["id", "name", "title", "rationale", "confidence"]) {
    if (typeof s[k] !== "string") throw new Error(`suggestion.${k} must be a string`);
  }
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
    if (payload.triggers !== undefined) {
      if (!Array.isArray(payload.triggers) || payload.triggers.some(t => typeof t !== "string")) {
        throw new Error("command payload triggers must be an array of strings");
      }
    }
  }
  if (payload.type === "hook") {
    if (typeof payload.event !== "string" || typeof payload.subcommand !== "string") {
      throw new Error("hook payload needs event + subcommand");
    }
  }
  if (payload.type === "rule") {
    if (payload.target !== "project" && payload.target !== "user") {
      throw new Error("rule payload target must be project|user");
    }
    if (typeof payload.ruleName !== "string") throw new Error("rule payload needs ruleName");
    if (typeof payload.text !== "string") throw new Error("rule payload needs text");
  }
}

export function assertHookRunnable(s: Suggestion): void {
  if (s.payload.type !== "hook") return;
  if (!KNOWN_SUBCOMMANDS.has(s.payload.subcommand)) {
    throw new Error(`hook references unknown gradient subcommand: ${s.payload.subcommand}`);
  }
}
