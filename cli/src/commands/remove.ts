import { rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { removeEntry } from "../core/manifest.js";
import { assertInside } from "../core/security.js";

export async function remove(projectDir: string, name: string): Promise<boolean> {
  const entry = await removeEntry(projectDir, name);
  if (!entry) return false;
  if (entry.path) {
    const abs = isAbsolute(entry.path) ? entry.path : join(projectDir, entry.path);
    // Containment: never delete outside the project's .claude dir, even if the
    // manifest was tampered with (mirror the boundary apply.ts enforces on write).
    assertInside(join(projectDir, ".claude"), abs);
    try { await unlink(abs); } catch { /* already gone */ }
    if (entry.type === "skill") {
      try { await rmdir(dirname(abs)); } catch { /* non-empty or already gone */ }
    }
  }
  return true;
}
