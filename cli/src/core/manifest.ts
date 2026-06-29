import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ManifestEntry } from "../types";

// .gradient/manifest.json tracks every generated artifact so apply is reversible.
export function manifestPath(cwd: string = process.cwd()): string {
  return join(cwd, ".gradient", "manifest.json");
}

export function readManifest(cwd: string = process.cwd()): ManifestEntry[] {
  const p = manifestPath(cwd);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(data) ? (data as ManifestEntry[]) : [];
  } catch {
    return [];
  }
}

export function writeManifest(
  entries: ManifestEntry[],
  cwd: string = process.cwd(),
): void {
  const p = manifestPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(entries, null, 2)}\n`);
}

/** Idempotent: re-adding the same name updates rather than duplicates. */
export function addEntry(entry: ManifestEntry, cwd: string = process.cwd()): void {
  const entries = readManifest(cwd).filter((e) => e.name !== entry.name);
  entries.push(entry);
  writeManifest(entries, cwd);
}

export function removeEntry(
  name: string,
  cwd: string = process.cwd(),
): ManifestEntry | undefined {
  const entries = readManifest(cwd);
  const found = entries.find((e) => e.name === name);
  writeManifest(
    entries.filter((e) => e.name !== name),
    cwd,
  );
  return found;
}
