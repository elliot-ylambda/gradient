import { unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { removeEntry } from "../core/manifest.js";

export async function remove(projectDir: string, name: string): Promise<boolean> {
  const entry = await removeEntry(projectDir, name);
  if (!entry) return false;
  if (entry.path) {
    const abs = isAbsolute(entry.path) ? entry.path : join(projectDir, entry.path);
    try { await unlink(abs); } catch { /* already gone */ }
  }
  return true;
}
