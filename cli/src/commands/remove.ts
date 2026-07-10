import { rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { loadManifest, removeEntry } from "../core/manifest.js";
import { assertInside } from "../core/security.js";
import { refreshRecallIndex } from "./recall.js";
import { assertNoSymlinkPath, safeUnlink } from "../core/safeFs.js";

export async function remove(
  projectDir: string,
  name: string,
  opts: { home?: string } = {},
): Promise<boolean> {
  const entry = (await loadManifest(projectDir)).find(candidate => candidate.name === name);
  if (!entry) return false;
  if (entry.path) {
    const abs = isAbsolute(entry.path) ? entry.path : join(projectDir, entry.path);
    // Containment: never delete outside the project's .claude dir, even if the
    // manifest was tampered with (mirror the boundary apply.ts enforces on write).
    assertInside(join(projectDir, ".claude"), abs);
    await assertNoSymlinkPath(projectDir, abs, { includeTarget: false });
    try { await safeUnlink(projectDir, abs); } catch { /* already gone */ }
    if (entry.type === "skill") {
      await assertNoSymlinkPath(projectDir, dirname(abs));
      try { await rmdir(dirname(abs)); } catch { /* non-empty or already gone */ }
    }
  }
  // Only mutate the manifest after the target passed containment checks.
  await removeEntry(projectDir, name);
  await refreshRecallIndex(projectDir, opts.home);
  return true;
}
