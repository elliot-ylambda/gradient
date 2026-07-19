import type { Suggestion } from "./types.js";
import { AUTHORIZATION_GUARD, clarifiedWorkflowBody } from "./detect.js";
import { sanitizeName, stripUnsafeControls } from "./security.js";

export const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set(["checkpoint", "scan", "session-start", "recap", "notify"]);
const TYPES = new Set(["command", "loop", "hook", "rule"]);
const CONFIDENCES = new Set(["high", "inferred", "flagged"]);
const HOOK_EVENTS = new Set(["PreCompact", "SessionStart", "Notification", "PostToolUse"]);
const NOTIFICATION_MATCHER = "permission_prompt|idle_prompt";
const TEXT_CAP = 8_000;

function validText(value: unknown, cap = TEXT_CAP): value is string {
  return typeof value === "string" && value.length <= cap && stripUnsafeControls(value) === value;
}

function validOneLine(value: unknown, cap: number): value is string {
  return validText(value, cap) && value.trim().length > 0 && !/[\r\n\t]/.test(value);
}

function validHookTuple(payload: Record<string, unknown>): boolean {
  if (payload.event === "PreCompact") {
    return payload.subcommand === "checkpoint" && payload.matcher === undefined;
  }
  if (payload.event === "SessionStart") {
    if (payload.subcommand === "session-start") return payload.matcher === undefined;
    return (payload.subcommand === "scan" || payload.subcommand === "recap") &&
      (payload.matcher === undefined || payload.matcher === "resume|compact");
  }
  if (payload.event === "Notification") {
    return payload.subcommand === "notify" && payload.matcher === NOTIFICATION_MATCHER;
  }
  return false;
}

export function validateSuggestion(x: unknown): asserts x is Suggestion {
  const s = x as Record<string, unknown>;
  if (!s || typeof s !== "object") throw new Error("suggestion is not an object");
  for (const k of ["id", "name", "title", "rationale", "confidence"]) {
    if (!validText(s[k], k === "rationale" ? 2_000 : 500)) throw new Error(`suggestion.${k} must be safe bounded text`);
  }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(s.id as string)) throw new Error("suggestion.id must be an opaque safe id");
  if (sanitizeName(s.name as string) !== s.name) throw new Error("suggestion.name must be sanitized");
  if (!CONFIDENCES.has(s.confidence as string)) {
    throw new Error(`invalid confidence: ${String(s.confidence)}`);
  }

  const payload = s.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") throw new Error("suggestion.payload missing");
  if (typeof payload.type !== "string" || !TYPES.has(payload.type)) {
    throw new Error(`invalid payload.type: ${String(payload.type)}`);
  }
  if (payload.type === "command") {
    if (!validText(payload.commandName, 100) || !validText(payload.body)) {
      throw new Error("command payload needs safe bounded commandName + body");
    }
    if (payload.commandName !== s.name) throw new Error("commandName must match suggestion.name");
    if (payload.triggers !== undefined) {
      if (!Array.isArray(payload.triggers) || payload.triggers.length > 20 || payload.triggers.some(t => !validText(t, 1_000))) {
        throw new Error("command payload triggers must be an array of strings");
      }
    }
    if (payload.mechanical !== undefined && typeof payload.mechanical !== "boolean") {
      throw new Error("command payload mechanical must be a boolean");
    }
  }
  if (payload.type === "loop") {
    if (!validText(payload.instruction, 2_000) ||
      (payload.cadence !== undefined && !validText(payload.cadence, 100))) {
      throw new Error("loop payload needs a safe bounded instruction");
    }
  }
  if (payload.type === "hook") {
    if (!validText(payload.event, 50) || !HOOK_EVENTS.has(payload.event)) {
      throw new Error("hook payload needs a supported event");
    }
    const hasSubcommand = typeof payload.subcommand === "string";
    const hasCommand = typeof payload.command === "string";
    if (hasSubcommand === hasCommand) {
      throw new Error("hook payload needs exactly one of subcommand | command");
    }
    if (hasSubcommand) {
      if (!validText(payload.subcommand, 50) || !KNOWN_SUBCOMMANDS.has(payload.subcommand)) {
        throw new Error("hook payload needs a supported subcommand");
      }
      if (!validHookTuple(payload)) throw new Error("hook event, matcher, and subcommand are not an approved combination");
    } else {
      if (payload.event !== "PostToolUse") throw new Error("command hooks support only PostToolUse");
      const command = (payload.command as string).trim();
      if (!command || command.length > 200 || /[\r\n]/.test(payload.command as string) ||
        !validText(payload.command, 200)) {
        throw new Error("hook command must be a non-empty single line of ≤ 200 chars");
      }
    }
    if (payload.matcher !== undefined) {
      if (!validText(payload.matcher, 500) || /[\r\n\t]/.test(payload.matcher)) {
        throw new Error("hook matcher must be a safe regex source of ≤ 500 chars");
      }
      try {
        new RegExp(payload.matcher);
      } catch {
        throw new Error(`invalid hook matcher: ${String(payload.matcher)}`);
      }
    }
    if (payload.description !== undefined && !validText(payload.description, 1_000)) {
      throw new Error("hook description must be safe bounded text");
    }
  }
  if (payload.type === "rule") {
    if (payload.target !== "project" && payload.target !== "user") {
      throw new Error("rule payload target must be project|user");
    }
    if (!validText(payload.ruleName, 100) || sanitizeName(payload.ruleName) !== payload.ruleName) {
      throw new Error("rule payload needs a safe sanitized ruleName");
    }
    if (payload.ruleName !== s.name) throw new Error("ruleName must match suggestion.name");
    if (!validText(payload.text, 2_000) || payload.text.trim().length === 0) {
      throw new Error("rule payload needs safe bounded text");
    }
  }

  if (s.clarify !== undefined) {
    if (payload.type !== "command") throw new Error("suggestion.clarify is supported only for commands");
    const clarify = s.clarify as Record<string, unknown> | null;
    if (!clarify || typeof clarify !== "object" || !validOneLine(clarify.question, 300)) {
      throw new Error("suggestion.clarify needs a safe bounded one-line question");
    }
    if (!Array.isArray(clarify.options) || clarify.options.length < 2 || clarify.options.length > 3) {
      throw new Error("suggestion.clarify needs 2-3 options");
    }
    const labels: string[] = [];
    for (const option of clarify.options) {
      const fields = option as Record<string, unknown> | null;
      if (!fields || typeof fields !== "object" || !validOneLine(fields.label, 100) ||
        !validText(fields.body) || fields.body !== clarifiedWorkflowBody(fields.label)) {
        throw new Error("suggestion.clarify options must use safe labels and locally reconstructed bodies");
      }
      labels.push(fields.label);
    }
    if (new Set(labels).size !== labels.length) throw new Error("suggestion.clarify option labels must be unique");
    if (clarify.chosen !== undefined) {
      if (typeof clarify.chosen !== "string" || !labels.includes(clarify.chosen)) {
        throw new Error("suggestion.clarify chosen must match an option");
      }
      if (s.confidence !== "high") throw new Error("resolved suggestion confidence must be high");
      if (payload.body !== clarifiedWorkflowBody(clarify.chosen)) {
        throw new Error("resolved clarification payload must use its locally reconstructed body");
      }
    } else if (s.confidence !== "flagged") {
      throw new Error("unresolved clarification requires flagged confidence");
    }
    if (!(payload.body as string).includes(AUTHORIZATION_GUARD)) {
      throw new Error("clarified command is missing its authorization guard");
    }
  }

  const evidence = s.evidence as Record<string, unknown> | undefined;
  if (!evidence || !Number.isInteger(evidence.count) || (evidence.count as number) < 0 ||
    (evidence.count as number) > 1_000_000_000 ||
    !Number.isInteger(evidence.sessions) || (evidence.sessions as number) < 0 ||
    (evidence.sessions as number) > 1_000_000_000) {
    throw new Error("suggestion.evidence must contain non-negative integer counts");
  }
  if (evidence.assistants !== undefined && (
    !Array.isArray(evidence.assistants) ||
    evidence.assistants.length > 2 ||
    new Set(evidence.assistants).size !== evidence.assistants.length ||
    evidence.assistants.some(value => value !== "claude-code" && value !== "codex")
  )) {
    throw new Error("suggestion.evidence assistants must contain known unique assistants");
  }
  if (s.examples !== undefined &&
    (!Array.isArray(s.examples) || s.examples.length > 5 || s.examples.some(example => !validText(example, 2_000)))) {
    throw new Error("suggestion.examples must contain safe bounded text");
  }
}

export function assertHookRunnable(s: Suggestion): void {
  if (s.payload.type !== "hook") return;
  const payload = s.payload as unknown as Record<string, unknown>;
  if (s.payload.command !== undefined) {
    if (s.payload.event !== "PostToolUse") {
      throw new Error(`command hooks support only PostToolUse: ${s.payload.event}`);
    }
    return;
  }
  if (s.payload.subcommand === undefined || !KNOWN_SUBCOMMANDS.has(s.payload.subcommand) || !validHookTuple(payload)) {
    throw new Error(
      `hook references an unsupported event/matcher/subcommand combination: ${s.payload.event}/${s.payload.subcommand}`,
    );
  }
}
