import { rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadManifest, removeEntry } from "../core/manifest.js";
import { artifactHasMarker, expectedArtifactPath } from "../core/manifest.js";
import { assertInside } from "../core/security.js";
import { refreshRecallIndex } from "./recall.js";
import { assertNoSymlinkPath, safeReadFile, safeUnlink } from "../core/safeFs.js";
import { revokeArtifactApproval } from "../core/approvals.js";

export async function remove(
  projectDir: string,
  name: string,
  opts: { home?: string } = {},
): Promise<boolean> {
  const entry = (await loadManifest(projectDir)).find(candidate => candidate.name === name);
  if (!entry) return false;
  if (entry.path) {
    const abs = expectedArtifactPath(projectDir, entry);
    // Containment: never delete outside the project's .claude dir, even if the
    // manifest was tampered with (mirror the boundary apply.ts enforces on write).
    assertInside(join(projectDir, ".claude"), abs);
    await assertNoSymlinkPath(projectDir, abs, { includeTarget: false });
    try {
      const content = await safeReadFile(projectDir, abs, { maxBytes: 1_000_000 });
      if (!artifactHasMarker(content, entry)) {
        throw new Error(`refusing to remove artifact without matching gradient provenance: ${abs}`);
      }
      await safeUnlink(projectDir, abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (entry.type === "skill") {
      await assertNoSymlinkPath(projectDir, dirname(abs));
      try { await rmdir(dirname(abs)); } catch { /* non-empty or already gone */ }
    }
  }
  // Only mutate the manifest after the target passed containment checks.
  await removeEntry(projectDir, name);
  await revokeArtifactApproval(projectDir, name, opts.home);
  await refreshRecallIndex(projectDir, opts.home);
  return true;
}
