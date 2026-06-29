import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ManifestEntry } from "./types.js";

export function gradientDir(projectDir: string): string {
  return join(projectDir, ".gradient");
}

function manifestPath(projectDir: string): string {
  return join(gradientDir(projectDir), "manifest.json");
}

export async function loadManifest(projectDir: string): Promise<ManifestEntry[]> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(projectDir), "utf8");
  } catch {
    return []; // absent manifest → empty
  }
  return JSON.parse(raw) as ManifestEntry[]; // corrupt JSON throws loudly (no silent data loss)
}

async function save(projectDir: string, entries: ManifestEntry[]): Promise<void> {
  await mkdir(gradientDir(projectDir), { recursive: true });
  await writeFile(manifestPath(projectDir), JSON.stringify(entries, null, 2));
}

export async function addEntry(projectDir: string, e: ManifestEntry): Promise<void> {
  const entries = (await loadManifest(projectDir)).filter(x => x.name !== e.name);
  entries.push(e);
  await save(projectDir, entries);
}

export async function removeEntry(projectDir: string, name: string): Promise<ManifestEntry | undefined> {
  const entries = await loadManifest(projectDir);
  const found = entries.find(x => x.name === name);
  if (!found) return undefined;
  await save(projectDir, entries.filter(x => x.name !== name));
  return found;
}
