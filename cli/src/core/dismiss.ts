import { join } from "node:path";
import type { Suggestion } from "./types.js";
import { gradientDir } from "./manifest.js";
import { safeReadFile, safeWriteFile } from "./safeFs.js";
import { redact, sanitizeName, stripUnsafeControls } from "./security.js";

export interface Dismissal {
  id: string;
  name: string;
  signatures: string[];
  dismissedAt: string;
}

export const DISMISSAL_MAX_ENTRIES = 1_000;
export const DISMISSAL_MAX_SIGNATURES = 100;
export const DISMISSAL_MAX_BYTES = 1_000_000;
const SIGNATURE_MAX_CHARS = 1_000;

export function dismissedPath(projectDir: string): string {
  return join(gradientDir(projectDir), "dismissed.json");
}

function safeOneLine(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    stripUnsafeControls(value) === value && !/[\r\n\t]/.test(value);
}

function validateDismissal(value: unknown): Dismissal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dismissal must be an object");
  }
  const entry = value as Record<string, unknown>;
  if (!safeOneLine(entry.id, 100) || !/^[A-Za-z0-9_-]+$/.test(entry.id)) {
    throw new Error("dismissal id is invalid");
  }
  if (!safeOneLine(entry.name, 100) || sanitizeName(entry.name) !== entry.name) {
    throw new Error("dismissal name is invalid");
  }
  if (!Array.isArray(entry.signatures) || entry.signatures.length > DISMISSAL_MAX_SIGNATURES ||
    entry.signatures.some(signature =>
      !safeOneLine(signature, SIGNATURE_MAX_CHARS) || redact(signature) !== signature) ||
    new Set(entry.signatures).size !== entry.signatures.length) {
    throw new Error("dismissal signatures are invalid");
  }
  if (!safeOneLine(entry.dismissedAt, 100) || !Number.isFinite(Date.parse(entry.dismissedAt))) {
    throw new Error("dismissal timestamp is invalid");
  }
  return {
    id: entry.id,
    name: entry.name,
    signatures: [...entry.signatures].sort(),
    dismissedAt: entry.dismissedAt,
  };
}

/** Session-start reads this state on the latency-sensitive path, so malformed,
 * oversized, absent, or symlinked state deliberately fails closed to an empty
 * list without writing or printing anything. */
export async function loadDismissed(projectDir: string): Promise<Dismissal[]> {
  try {
    const parsed = JSON.parse(await safeReadFile(
      projectDir,
      dismissedPath(projectDir),
      { maxBytes: DISMISSAL_MAX_BYTES },
    )) as unknown;
    if (!Array.isArray(parsed) || parsed.length > DISMISSAL_MAX_ENTRIES) return [];
    return parsed.map(validateDismissal);
  } catch {
    return [];
  }
}

function signatureKey(signatures: string[]): string {
  return signatures.join("\u0000");
}

export function isDismissed(suggestion: Suggestion, dismissed: Dismissal[]): boolean {
  const signatures = [...new Set(suggestion.sourceSignatures ?? [])].sort();
  if (signatures.length === 0) return dismissed.some(entry => entry.id === suggestion.id);
  return dismissed.some(entry => {
    const prior = new Set(entry.signatures);
    return signatures.every(signature => prior.has(signature));
  });
}

export async function addDismissal(
  projectDir: string,
  suggestion: Suggestion,
  now = new Date(),
): Promise<void> {
  const entry = validateDismissal({
    id: suggestion.id,
    name: suggestion.name,
    signatures: [...new Set(suggestion.sourceSignatures ?? [])].sort(),
    dismissedAt: now.toISOString(),
  });
  const key = signatureKey(entry.signatures);
  const prior = (await loadDismissed(projectDir)).filter(candidate =>
    candidate.id !== entry.id && signatureKey(candidate.signatures) !== key);
  let retained = [...prior, entry].slice(-DISMISSAL_MAX_ENTRIES);
  let data = `${JSON.stringify(retained, null, 2)}\n`;
  while (Buffer.byteLength(data, "utf8") > DISMISSAL_MAX_BYTES && retained.length > 1) {
    retained = retained.slice(1);
    data = `${JSON.stringify(retained, null, 2)}\n`;
  }
  if (Buffer.byteLength(data, "utf8") > DISMISSAL_MAX_BYTES) {
    throw new Error(`dismissal state exceeds ${DISMISSAL_MAX_BYTES} byte cap`);
  }
  await safeWriteFile(projectDir, dismissedPath(projectDir), data, { mode: 0o600 });
}
