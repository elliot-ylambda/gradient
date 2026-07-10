import { isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactType, Assistant, ManifestEntry, Suggestion } from "./types.js";
import { sanitizeName, stripUnsafeControls } from "./security.js";
import { safeReadFile, safeWriteFile } from "./safeFs.js";

const MANIFEST_MAX_BYTES = 1_000_000;
const MANIFEST_MAX_ENTRIES = 1_000;
const ARTIFACT_TYPES = new Set<ArtifactType>(["command", "loop", "hook", "skill", "rule"]);
const ASSISTANTS = new Set<Assistant>(["claude-code", "codex"]);

export function gradientDir(projectDir: string): string {
  return join(projectDir, ".gradient");
}

function manifestPath(projectDir: string): string {
  return join(gradientDir(projectDir), "manifest.json");
}

export function manifestTarget(entry: Pick<ManifestEntry, "target">): Assistant {
  return entry.target ?? "claude-code";
}

export function artifactMarker(value: Pick<Suggestion, "id" | "name"> | Pick<ManifestEntry, "suggestionId" | "name">): string {
  const id = "id" in value ? value.id : value.suggestionId;
  return `<!-- gradient:generated id=${id} name=${value.name} -->`;
}

export function artifactHasMarker(
  content: string,
  value: Pick<ManifestEntry, "suggestionId" | "name">,
): boolean {
  return content.slice(0, 2_000).includes(artifactMarker(value));
}

function expectedRelativePath(type: ArtifactType, name: string, target: Assistant): string | null {
  if (target === "codex") {
    if (type === "skill") return `.agents/skills/${name}/SKILL.md`;
    return null;
  }
  switch (type) {
    case "skill": return `.claude/skills/${name}/SKILL.md`;
    case "command": return `.claude/commands/${name}.md`;
    case "rule": return `.claude/rules/gradient-${name}.md`;
    case "loop":
    case "hook": return null;
  }
}

/** Recompute the only path an entry is allowed to control. Empty is valid for
 * print-only artifacts; callers never use an arbitrary stored path. */
export function expectedArtifactPath(projectDir: string, entry: ManifestEntry): string {
  if (!entry.path) return "";
  const rel = expectedRelativePath(entry.type, entry.name, manifestTarget(entry));
  return rel === null ? "" : join(projectDir, rel);
}

function validateEntry(projectDir: string, value: unknown, index: number): ManifestEntry {
  const entry = value as Record<string, unknown>;
  if (!entry || typeof entry !== "object") throw new Error(`manifest entry ${index} is not an object`);
  if (typeof entry.name !== "string" || sanitizeName(entry.name) !== entry.name || entry.name.length > 40) {
    throw new Error(`manifest entry ${index} has an invalid name`);
  }
  if (typeof entry.type !== "string" || !ARTIFACT_TYPES.has(entry.type as ArtifactType)) {
    throw new Error(`manifest entry ${index} has an invalid type`);
  }
  if (entry.target !== undefined && (typeof entry.target !== "string" || !ASSISTANTS.has(entry.target as Assistant))) {
    throw new Error(`manifest entry ${index} has an invalid target`);
  }
  if (entry.target === "codex" && entry.type !== "skill" && entry.type !== "rule") {
    throw new Error(`manifest entry ${index} has an unsupported codex artifact type`);
  }
  if (typeof entry.path !== "string" || stripUnsafeControls(entry.path) !== entry.path) {
    throw new Error(`manifest entry ${index} has an invalid path`);
  }
  const date = typeof entry.createdAt === "string" ? entry.createdAt : "";
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error(`manifest entry ${index} has an invalid date`);
  }
  if (typeof entry.suggestionId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.suggestionId)) {
    throw new Error(`manifest entry ${index} has an invalid suggestion id`);
  }

  const typed = entry as unknown as ManifestEntry;
  const expectedRelative = expectedRelativePath(typed.type, typed.name, manifestTarget(typed));
  if (expectedRelative === null || (typed.type === "rule" && typed.path === "")) {
    if (typed.path !== "") throw new Error(`manifest entry ${index} must not control a file`);
  } else {
    if (!typed.path) throw new Error(`manifest entry ${index} is missing its generated path`);
    const expected = join(projectDir, expectedRelative);
    const actual = isAbsolute(typed.path) ? resolve(typed.path) : resolve(projectDir, typed.path);
    if (actual !== resolve(expected)) throw new Error(`manifest entry ${index} path does not match its type/name/target`);
    const rel = relative(resolve(projectDir), actual);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`manifest entry ${index} escapes the project`);
  }
  return typed;
}

export async function loadManifest(projectDir: string): Promise<ManifestEntry[]> {
  let raw: string;
  try {
    raw = await safeReadFile(projectDir, manifestPath(projectDir), { maxBytes: MANIFEST_MAX_BYTES });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length > MANIFEST_MAX_ENTRIES) {
    throw new Error("manifest must be a bounded array");
  }
  return parsed.map((entry, index) => validateEntry(projectDir, entry, index));
}

async function save(projectDir: string, entries: ManifestEntry[]): Promise<void> {
  if (entries.length > MANIFEST_MAX_ENTRIES) throw new Error("manifest entry cap exceeded");
  entries.forEach((entry, index) => validateEntry(projectDir, entry, index));
  await safeWriteFile(projectDir, manifestPath(projectDir), `${JSON.stringify(entries, null, 2)}\n`);
}

function keyOf(entry: Pick<ManifestEntry, "name" | "target">): string {
  return `${entry.name}\u0000${manifestTarget(entry)}`;
}

export async function addEntry(projectDir: string, entry: ManifestEntry): Promise<void> {
  validateEntry(projectDir, entry, 0);
  const entries = (await loadManifest(projectDir)).filter(existing => keyOf(existing) !== keyOf(entry));
  entries.push(entry);
  await save(projectDir, entries);
}

/** Remove every assistant target for an artifact name. */
export async function removeEntries(projectDir: string, name: string): Promise<ManifestEntry[]> {
  const entries = await loadManifest(projectDir);
  const found = entries.filter(entry => entry.name === name);
  if (found.length === 0) return [];
  await save(projectDir, entries.filter(entry => entry.name !== name));
  return found;
}
