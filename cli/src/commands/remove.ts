import { rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { removeEntries } from "../core/manifest.js";
import { assertInside } from "../core/security.js";
import { refreshRecallIndex } from "./recall.js";

export async function remove(
  projectDir: string,
  name: string,
  opts: { home?: string } = {},
): Promise<boolean> {
  const entries = await removeEntries(projectDir, name);
  if (entries.length === 0) return false;
  for (const entry of entries) {
    if (entry.path) {
      const abs = isAbsolute(entry.path) ? entry.path : join(projectDir, entry.path);
      const root = entry.target === "codex" ? ".agents" : ".claude";
      // Containment: never delete outside the assistant's project directory,
      // even if the manifest was tampered with.
      assertInside(join(projectDir, root), abs);
      try { await unlink(abs); } catch { /* already gone */ }
      if (entry.type === "skill") {
        try { await rmdir(dirname(abs)); } catch { /* non-empty or already gone */ }
      }
    }
  }
  await refreshRecallIndex(projectDir, opts.home);
  return true;
}
