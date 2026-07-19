import { homedir } from "node:os";
import { join } from "node:path";
import { projectCacheDir } from "../config.js";
import { cluster, normalize, similarity } from "./cluster.js";
import type { InstructionLine } from "./instructions.js";
import { safeReadFile, safeUnlink, safeWriteFile } from "./safeFs.js";
import { stripUnsafeControls } from "./security.js";
import type { Assistant, Candidate, Turn } from "./types.js";

export const AUDIT = {
  SIM: 0.7,
  MIN_COUNT: 3,
  MIN_SESSIONS: 2,
  MAX_CORRECTION_LEN: 200,
} as const;

export const CORRECTION_RE =
  /^(?:no[,.!\s]|don'?t\s|do not\s|stop(?:\s|[,.!-])|never\s|actually(?:\s|[,])|instead(?:\s|[,])|that'?s (?:wrong|not right)|wrong(?:\s|[,.])|undo\s|revert\s)/i;

export interface InstructionTally {
  file: string;
  source: InstructionLine["source"];
  text: string;
  restatements: number;
  violations: number;
  lastSeen: string;
}

export interface InstructionAuditSnapshot {
  generatedAt: string;
  tallies: InstructionTally[];
}

const AUDIT_CACHE_MAX_BYTES = 1_000_000;
const AUDIT_TALLY_CAP = 2_000;

export function auditCachePath(projectDir: string, home?: string): string {
  return join(projectCacheDir(projectDir, home), "instruction-audit.json");
}

function validTally(value: unknown): value is InstructionTally {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tally = value as Record<string, unknown>;
  return typeof tally.file === "string" && tally.file.length <= 4_096 && !/[\r\n\t]/.test(tally.file) && stripUnsafeControls(tally.file) === tally.file &&
    (tally.source === "project" || tally.source === "project-local" || tally.source === "rule" || tally.source === "user") &&
    typeof tally.text === "string" && tally.text.length <= 200 && !/[\r\n\t]/.test(tally.text) && stripUnsafeControls(tally.text) === tally.text &&
    Number.isSafeInteger(tally.restatements) && (tally.restatements as number) >= 0 && (tally.restatements as number) <= 1_000_000_000 &&
    Number.isSafeInteger(tally.violations) && (tally.violations as number) >= 0 && (tally.violations as number) <= 1_000_000_000 &&
    typeof tally.lastSeen === "string" && tally.lastSeen.length <= 100 && !/[\r\n\t]/.test(tally.lastSeen) && stripUnsafeControls(tally.lastSeen) === tally.lastSeen;
}

function validatedSnapshot(value: unknown): InstructionAuditSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("instruction audit must be an object");
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.generatedAt !== "string" || snapshot.generatedAt.length > 100 ||
    !Number.isFinite(Date.parse(snapshot.generatedAt))) {
    throw new Error("instruction audit has an invalid timestamp");
  }
  if (!Array.isArray(snapshot.tallies) || snapshot.tallies.length > AUDIT_TALLY_CAP ||
    snapshot.tallies.some(tally => !validTally(tally))) {
    throw new Error("instruction audit has invalid tallies");
  }
  return snapshot as unknown as InstructionAuditSnapshot;
}

export async function saveInstructionAudit(
  projectDir: string,
  tallies: InstructionTally[],
  home?: string,
): Promise<string> {
  const userHome = home ?? homedir();
  const snapshot = validatedSnapshot({ generatedAt: new Date().toISOString(), tallies });
  const path = auditCachePath(projectDir, userHome);
  await safeWriteFile(userHome, path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export async function loadInstructionAudit(
  projectDir: string,
  home?: string,
): Promise<InstructionAuditSnapshot | null> {
  const userHome = home ?? homedir();
  try {
    return validatedSnapshot(JSON.parse(await safeReadFile(
      userHome,
      auditCachePath(projectDir, userHome),
      { maxBytes: AUDIT_CACHE_MAX_BYTES },
    )));
  } catch {
    return null;
  }
}

export async function clearInstructionAudit(projectDir: string, home?: string): Promise<void> {
  const userHome = home ?? homedir();
  try {
    await safeUnlink(userHome, auditCachePath(projectDir, userHome));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface AuditOptions {
  /** When supplied, only these already-context-checked turns may enter the
   * correction detector. Restatements still use the full prompt set. */
  confirmedCorrections?: Turn[];
}

function semanticNormalize(text: string): string {
  return normalize(text)
    .replace(/\b(?:don'?t|do not|not)\b/g, "never")
    .replace(/\b(?:always|please|okay|ok)\b/g, " ")
    .replace(/[.,!?;:'"`()\[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function correctionCanonical(text: string): string {
  const explicitNo = /^\s*no[,.!]\s*/i.test(text);
  let canonical = semanticNormalize(text);
  if (explicitNo) canonical = canonical.replace(/^no\s+/, "");
  else if (/^no\s+/.test(canonical)) canonical = canonical.replace(/^no\s+/, "never use ");
  canonical = canonical
    .replace(/^(?:actually|instead|stop|wrong)\s+/, "")
    .replace(/^thats (?:wrong|never right)\s*/, "")
    .trim();
  return canonical;
}

function bestMatch(value: string, instructions: InstructionLine[]): InstructionLine | undefined {
  const normalized = semanticNormalize(value);
  let best: InstructionLine | undefined;
  let bestScore = 0;
  for (const instruction of instructions) {
    const score = similarity(normalized, semanticNormalize(instruction.text));
    if (score >= AUDIT.SIM && score > bestScore) {
      best = instruction;
      bestScore = score;
    }
  }
  return best;
}

function turnKey(turn: Turn): string {
  return `${turn.sessionId}\u0000${turn.ts}\u0000${turn.text ?? ""}`;
}

function assistants(turns: Turn[]): Assistant[] | undefined {
  const values = [...new Set(turns.map(turn => turn.assistant ?? "claude-code"))];
  return values.length > 0 ? values.sort() : undefined;
}

function latest(turns: Turn[]): string {
  return turns.reduce((value, turn) => turn.ts > value ? turn.ts : value, "");
}

export function audit(
  prompts: Turn[],
  instructions: InstructionLine[],
  options: AuditOptions = {},
): { candidates: Candidate[]; tallies: InstructionTally[] } {
  const tallies = new Map<InstructionLine, InstructionTally>();
  const tally = (instruction: InstructionLine): InstructionTally => {
    const existing = tallies.get(instruction);
    if (existing) return existing;
    const created: InstructionTally = {
      file: instruction.file,
      source: instruction.source,
      text: instruction.text,
      restatements: 0,
      violations: 0,
      lastSeen: "",
    };
    tallies.set(instruction, created);
    return created;
  };

  const restated = new Map<InstructionLine, Turn[]>();
  const inferredCorrections: Turn[] = [];
  for (const prompt of prompts) {
    const text = prompt.text?.trim() ?? "";
    if (!text) continue;
    if (CORRECTION_RE.test(text)) {
      if (options.confirmedCorrections === undefined && text.length < AUDIT.MAX_CORRECTION_LEN) {
        inferredCorrections.push(prompt);
      }
      continue;
    }
    const hit = bestMatch(text, instructions);
    if (!hit) continue;
    const hits = restated.get(hit) ?? [];
    hits.push(prompt);
    restated.set(hit, hits);
    const current = tally(hit);
    current.restatements++;
    if (prompt.ts > current.lastSeen) current.lastSeen = prompt.ts;
  }

  const promptKeys = new Set(prompts.map(turnKey));
  const corrections = options.confirmedCorrections === undefined
    ? inferredCorrections
    : options.confirmedCorrections.filter(prompt => {
      const text = prompt.text?.trim() ?? "";
      return promptKeys.has(turnKey(prompt)) && text.length < AUDIT.MAX_CORRECTION_LEN && CORRECTION_RE.test(text);
    });

  const candidates: Candidate[] = [];
  for (const [instruction, hits] of restated) {
    const sessionIds = [...new Set(hits.map(hit => hit.sessionId))].sort();
    if (hits.length < AUDIT.MIN_COUNT || sessionIds.length < AUDIT.MIN_SESSIONS) continue;
    candidates.push({
      kind: "instruction",
      signature: instruction.normalized,
      examples: hits.slice(0, 3).map(hit => hit.text ?? ""),
      count: hits.length,
      sessions: sessionIds.length,
      sessionIds,
      confidence: "inferred",
      ...(assistants(hits) ? { assistants: assistants(hits) } : {}),
      hint: `restated instruction (${instruction.source}): "${instruction.text}"`,
    });
  }

  const canonicalCorrections = corrections
    .map(prompt => ({ ...prompt, text: correctionCanonical(prompt.text ?? "") }))
    .filter(prompt => prompt.text.length > 0);
  for (const grouped of cluster(canonicalCorrections)) {
    if (grouped.count < AUDIT.MIN_COUNT || grouped.sessions < AUDIT.MIN_SESSIONS) continue;
    const groupedTurns = corrections.filter(prompt =>
      similarity(correctionCanonical(prompt.text ?? ""), grouped.signature) >= 0.6);
    const hit = bestMatch(grouped.signature, instructions);
    if (hit) {
      const current = tally(hit);
      current.violations += grouped.count;
      const seen = latest(groupedTurns);
      if (seen > current.lastSeen) current.lastSeen = seen;
      candidates.push({
        ...grouped,
        kind: "instruction",
        signature: hit.normalized,
        examples: groupedTurns.slice(0, 3).map(prompt => prompt.text ?? ""),
        ...(assistants(groupedTurns) ? { assistants: assistants(groupedTurns) } : {}),
        hint: `correction violating instruction (${hit.source}): "${hit.text}"`,
      });
    } else {
      candidates.push({
        ...grouped,
        kind: "instruction",
        examples: groupedTurns.slice(0, 3).map(prompt => prompt.text ?? ""),
        ...(assistants(groupedTurns) ? { assistants: assistants(groupedTurns) } : {}),
        hint: "repeated correction with no matching instruction",
      });
    }
  }

  return {
    candidates: candidates.sort((left, right) =>
      right.count - left.count || left.signature.localeCompare(right.signature)),
    tallies: [...tallies.values()]
      .filter(current => current.restatements + current.violations > 0)
      .sort((left, right) =>
        (right.restatements + right.violations) - (left.restatements + left.violations) ||
        left.file.localeCompare(right.file) || left.text.localeCompare(right.text)),
  };
}
