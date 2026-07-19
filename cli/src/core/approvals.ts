import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectCacheDir } from "../config.js";
import type { ArtifactType, Assistant, ManifestEntry } from "./types.js";
import { sanitizeName } from "./security.js";
import { safeReadFile, safeWriteFile } from "./safeFs.js";
import { manifestTarget } from "./manifest.js";

const APPROVAL_LEDGER_MAX_BYTES = 1_000_000;
const APPROVAL_LEDGER_MAX_ENTRIES = 1_000;
const ARTIFACT_TYPES = new Set<ArtifactType>(["command", "loop", "hook", "skill", "rule", "playbook-entry"]);
const ASSISTANTS = new Set<Assistant>(["claude-code", "codex"]);

/** Increment this whenever the generator's authority or content-safety
 * contract changes. A package-version check alone would accidentally trust
 * artifacts created by an older, unsafe generator with the same file marker. */
export const ARTIFACT_SAFETY_VERSION = 1;

export interface ArtifactApproval {
  suggestionId: string;
  name: string;
  type: ArtifactType;
  target: Assistant;
  contentSha256: string;
  safetyVersion: number;
}

export function approvalLedgerPath(projectDir: string, home?: string): string {
  return join(projectCacheDir(projectDir, home), "artifact-approvals.json");
}

export function artifactContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function validateApproval(value: unknown, index: number): ArtifactApproval {
  const record = value as Record<string, unknown>;
  if (!record || typeof record !== "object") throw new Error(`approval entry ${index} is not an object`);
  if (typeof record.suggestionId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(record.suggestionId)) {
    throw new Error(`approval entry ${index} has an invalid suggestion id`);
  }
  if (typeof record.name !== "string" || sanitizeName(record.name) !== record.name || record.name.length > 40) {
    throw new Error(`approval entry ${index} has an invalid name`);
  }
  if (typeof record.type !== "string" || !ARTIFACT_TYPES.has(record.type as ArtifactType)) {
    throw new Error(`approval entry ${index} has an invalid type`);
  }
  if (typeof record.target !== "string" || !ASSISTANTS.has(record.target as Assistant)) {
    throw new Error(`approval entry ${index} has an invalid target`);
  }
  if (typeof record.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.contentSha256)) {
    throw new Error(`approval entry ${index} has an invalid content hash`);
  }
  if (!Number.isSafeInteger(record.safetyVersion) || (record.safetyVersion as number) < 1) {
    throw new Error(`approval entry ${index} has an invalid safety version`);
  }
  return record as unknown as ArtifactApproval;
}

export async function loadArtifactApprovals(
  projectDir: string,
  home?: string,
): Promise<ArtifactApproval[]> {
  const userHome = home ?? homedir();
  let raw: string;
  try {
    raw = await safeReadFile(
      userHome,
      approvalLedgerPath(projectDir, userHome),
      { maxBytes: APPROVAL_LEDGER_MAX_BYTES },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`refusing unreadable artifact approval ledger: ${(error as Error).message}`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length > APPROVAL_LEDGER_MAX_ENTRIES) {
    throw new Error("artifact approval ledger must be a bounded array");
  }
  return parsed.map(validateApproval);
}

export function approvalMatches(
  approvals: ArtifactApproval[],
  entry: ManifestEntry,
  content: string,
): boolean {
  const hash = artifactContentHash(content);
  return approvals.some(approval =>
    approval.suggestionId === entry.suggestionId &&
    approval.name === entry.name &&
    approval.type === entry.type &&
    approval.target === manifestTarget(entry) &&
    approval.contentSha256 === hash &&
    approval.safetyVersion === ARTIFACT_SAFETY_VERSION
  );
}

export async function recordArtifactApproval(
  projectDir: string,
  entry: ManifestEntry,
  content: string,
  home?: string,
): Promise<void> {
  if (!entry.path) throw new Error("cannot approve a pathless artifact for export");
  const userHome = home ?? homedir();
  const approvals = (await loadArtifactApprovals(projectDir, userHome))
    .filter(existing => existing.name !== entry.name || existing.target !== manifestTarget(entry));
  approvals.push(validateApproval({
    suggestionId: entry.suggestionId,
    name: entry.name,
    type: entry.type,
    target: manifestTarget(entry),
    contentSha256: artifactContentHash(content),
    safetyVersion: ARTIFACT_SAFETY_VERSION,
  }, approvals.length));
  if (approvals.length > APPROVAL_LEDGER_MAX_ENTRIES) throw new Error("artifact approval ledger entry cap exceeded");
  await safeWriteFile(
    userHome,
    approvalLedgerPath(projectDir, userHome),
    `${JSON.stringify(approvals, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function revokeArtifactApproval(
  projectDir: string,
  name: string,
  home?: string,
): Promise<void> {
  const userHome = home ?? homedir();
  const approvals = await loadArtifactApprovals(projectDir, userHome);
  const remaining = approvals.filter(approval => approval.name !== name);
  if (remaining.length === approvals.length) return;
  await safeWriteFile(
    userHome,
    approvalLedgerPath(projectDir, userHome),
    `${JSON.stringify(remaining, null, 2)}\n`,
    { mode: 0o600 },
  );
}
