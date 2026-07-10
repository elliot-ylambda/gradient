import { isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactType, ManifestEntry, Suggestion } from "./types.js";
import { sanitizeName, stripUnsafeControls } from "./security.js";
import { safeReadFile, safeWriteFile } from "./safeFs.js";

const MANIFEST_MAX_BYTES = 1_000_000;
const MANIFEST_MAX_ENTRIES = 1_000;
const ARTIFACT_TYPES = new Set<ArtifactType>(["command", "loop", "hook", "skill", "rule"]);

export function gradientDir(projectDir: string): string {
  return join(projectDir, ".gradient");
}

function manifestPath(projectDir: string): string {
  return join(gradientDir(projectDir), "manifest.json");
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

function expectedRelativePath(type: ArtifactType, name: string, allowEmptyRule: boolean): string | null {
  switch (type) {
    case "skill": return `.claude/skills/${name}/SKILL.md`;
    case "command": return `.claude/commands/${name}.md`;
    case "rule": return allowEmptyRule ? null : `.claude/rules/gradient-${name}.md`;
    case "loop":
    case "hook": return null;
  }
}

/** Recompute the only path an entry is allowed to control. Empty is valid for
 * print-only artifacts; callers never use an arbitrary stored path. */
export function expectedArtifactPath(projectDir: string, entry: ManifestEntry): string {
  if (entry.type === "rule" && entry.path === "") return "";
  const rel = expectedRelativePath(entry.type, entry.name, false);
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
  if (typeof entry.path !== "string" || stripUnsafeControls(entry.path) !== entry.path) {
    throw new Error(`manifest entry ${index} has an invalid path`);
  }
  if (typeof entry.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.createdAt) ||
    !Number.isFinite(Date.parse(`${entry.createdAt}T00:00:00Z`))) {
    throw new Error(`manifest entry ${index} has an invalid date`);
  }
  if (typeof entry.suggestionId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.suggestionId)) {
    throw new Error(`manifest entry ${index} has an invalid suggestion id`);
  }

  const typed = entry as unknown as ManifestEntry;
  const expected = expectedArtifactPath(projectDir, typed);
  if (expected === "") {
    if (typed.path !== "") throw new Error(`manifest entry ${index} must not control a file`);
  } else {
    if (!typed.path) throw new Error(`manifest entry ${index} is missing its generated path`);
    const actual = isAbsolute(typed.path) ? resolve(typed.path) : resolve(projectDir, typed.path);
    if (actual !== resolve(expected)) throw new Error(`manifest entry ${index} path does not match its type/name`);
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
  await safeWriteFile(projectDir, manifestPath(projectDir), JSON.stringify(entries, null, 2));
}

export async function addEntry(projectDir: string, entry: ManifestEntry): Promise<void> {
  validateEntry(projectDir, entry, 0);
  const entries = (await loadManifest(projectDir)).filter(existing => existing.name !== entry.name);
  entries.push(entry);
  await save(projectDir, entries);
}

export async function removeEntry(projectDir: string, name: string): Promise<ManifestEntry | undefined> {
  const entries = await loadManifest(projectDir);
  const found = entries.find(entry => entry.name === name);
  if (!found) return undefined;
  await save(projectDir, entries.filter(entry => entry.name !== name));
  return found;
}
