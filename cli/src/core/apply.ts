import { isAbsolute, join, resolve } from "node:path";
import type { Suggestion, ManifestEntry, ArtifactType } from "./types.js";
import { emit, type EmitTarget } from "./emit/index.js";
import { assertInside } from "./security.js";
import { addEntry, loadManifest } from "./manifest.js";
import { artifactHasMarker } from "./manifest.js";
import { safeReadFile, safeWriteFile } from "./safeFs.js";
import { validateSuggestion } from "./validate.js";
import { recordArtifactApproval } from "./approvals.js";

export interface ApplyResult {
  suggestion: Suggestion;
  written?: string;
  printed?: string;
}

async function trackedTarget(projectDir: string, s: Suggestion, target: string): Promise<ManifestEntry | undefined> {
  const resolvedTarget = resolve(target);
  return (await loadManifest(projectDir)).find(entry => {
    if (entry.name !== s.name || entry.suggestionId !== s.id || !entry.path) return false;
    const entryPath = isAbsolute(entry.path) ? entry.path : join(projectDir, entry.path);
    return resolve(entryPath) === resolvedTarget;
  });
}

export async function applySuggestion(
  s: Suggestion,
  projectDir: string,
  opts: { emitTarget?: EmitTarget; home?: string } = {},
): Promise<ApplyResult> {
  validateSuggestion(s);
  const result = emit(s, { target: opts.emitTarget });
  let type: ArtifactType;
  let written: string | undefined;
  let printed: string | undefined;
  let approvalContent: string | undefined;

  if (result.kind === "command" || result.kind === "skill" || result.kind === "rule") {
    const abs = join(projectDir, result.path);
    assertInside(join(projectDir, ".claude"), abs);
    const tracked = await trackedTarget(projectDir, s, abs);
    if (tracked) {
      const existing = await safeReadFile(projectDir, abs, { maxBytes: 1_000_000 });
      if (!artifactHasMarker(existing, tracked)) {
        throw new Error(`refusing to overwrite artifact without matching gradient provenance: ${abs}`);
      }
      await safeWriteFile(projectDir, abs, result.content, { mode: 0o600 });
    } else {
      try {
        await safeWriteFile(projectDir, abs, result.content, { exclusive: true, mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`refusing to overwrite untracked artifact: ${abs}`);
        }
        throw error;
      }
    }
    written = abs;
    approvalContent = result.content;
    type = result.kind;
  } else if (result.kind === "loop") {
    printed = result.command;
    type = "loop";
  } else if (result.kind === "rule-print") {
    printed = result.text;
    type = "rule";
  } else {
    printed = result.settingsPatch; // hooks are surfaced for the user to approve into settings.json
    type = "hook";
  }

  const entry: ManifestEntry = {
    name: s.name,
    type,
    path: written ?? "",
    createdAt: new Date().toISOString().slice(0, 10),
    suggestionId: s.id,
  };
  await addEntry(projectDir, entry);
  // The repo-local manifest and marker prove ownership, not human approval.
  // Keep the export authorization outside the repository and bind it to the
  // exact bytes produced by the current hardened generator.
  if (written && approvalContent && (type === "skill" || type === "command" || type === "rule")) {
    await recordArtifactApproval(projectDir, entry, approvalContent, opts.home);
  }
  return { suggestion: s, written, printed };
}
