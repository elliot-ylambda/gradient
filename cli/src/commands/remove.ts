import { rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  artifactHasMarker,
  expectedArtifactPath,
  loadManifest,
  manifestTarget,
  removeEntries,
} from "../core/manifest.js";
import { assertInside } from "../core/security.js";
import { refreshRecallIndex } from "./recall.js";
import { assertNoSymlinkPath, safeReadFile, safeUnlink } from "../core/safeFs.js";
import { removeHook } from "../core/settings.js";
import {
  approvalMatches,
  hookApprovalContent,
  loadArtifactApprovals,
  revokeArtifactApproval,
} from "../core/approvals.js";

interface HookTuple {
  event: string;
  command: string;
  matcher?: string;
}

// These exact static tuples were installed by Gradient before private approval
// ledgers existed. Do not broaden this to a command-prefix check: a repository
// manifest is untrusted and must not be able to claim an arbitrary user hook
// merely because its command starts with `gradient `.
const LEGACY_GRADIENT_HOOKS: readonly HookTuple[] = [
  { event: "Stop", command: "gradient respond" },
  { event: "PreCompact", command: "gradient checkpoint" },
  { event: "SessionStart", command: "gradient scan" },
  { event: "SessionStart", command: "gradient scan --detach" },
  { event: "SessionStart", command: "gradient session-start" },
  // v0.4 manifests did not retain matchers, even when settings did.
  { event: "SessionStart", command: "gradient recap" },
  { event: "SessionStart", command: "gradient recap", matcher: "resume|compact" },
  { event: "UserPromptSubmit", command: "gradient recall" },
  { event: "Notification", command: "gradient notify" },
  { event: "Notification", command: "gradient notify", matcher: "permission_prompt|idle_prompt" },
];

function isLegacyGradientHook(hook: HookTuple): boolean {
  return LEGACY_GRADIENT_HOOKS.some(known =>
    known.event === hook.event &&
    known.command === hook.command &&
    known.matcher === hook.matcher,
  );
}

export async function remove(
  projectDir: string,
  name: string,
  opts: { home?: string } = {},
): Promise<boolean> {
  const entries = (await loadManifest(projectDir)).filter(entry => entry.name === name);
  if (entries.length === 0) return false;

  const existing: Array<{ path: string; skill: boolean }> = [];
  let approvals: Awaited<ReturnType<typeof loadArtifactApprovals>> | undefined;
  // Validate every target before deleting any of them. One forged entry must
  // not turn a multi-target remove into a partial destructive operation.
  for (const entry of entries) {
    if (entry.hook && !isLegacyGradientHook(entry.hook)) {
      approvals ??= await loadArtifactApprovals(projectDir, opts.home);
      if (!approvalMatches(approvals, entry, hookApprovalContent(entry.hook))) {
        throw new Error(`refusing to remove command hook without matching private approval: ${entry.name}`);
      }
    }
    if (!entry.path) continue;
    const path = expectedArtifactPath(projectDir, entry);
    const root = manifestTarget(entry) === "codex" ? ".agents" : ".claude";
    assertInside(join(projectDir, root), path);
    await assertNoSymlinkPath(projectDir, path, { includeTarget: false });
    try {
      const content = await safeReadFile(projectDir, path, { maxBytes: 1_000_000 });
      if (!artifactHasMarker(content, entry)) {
        throw new Error(`refusing to remove artifact without matching gradient provenance: ${path}`);
      }
      existing.push({ path, skill: entry.type === "skill" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  for (const artifact of existing) {
    await safeUnlink(projectDir, artifact.path);
    if (artifact.skill) {
      await assertNoSymlinkPath(projectDir, dirname(artifact.path));
      try { await rmdir(dirname(artifact.path)); } catch { /* non-empty or already gone */ }
    }
  }
  // Installed hooks own no file; un-merge the exact approved tuple from the
  // shared settings. Legacy gradient-owned commands predate private ledgers.
  for (const entry of entries) {
    if (entry.type === "hook" && entry.hook) {
      await removeHook(projectDir, entry.hook.event, entry.hook.command, entry.hook.matcher);
    }
  }
  await removeEntries(projectDir, name);
  await revokeArtifactApproval(projectDir, name, opts.home);
  await refreshRecallIndex(projectDir, opts.home);
  return true;
}
