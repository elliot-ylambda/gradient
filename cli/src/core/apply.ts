import { isAbsolute, join, resolve } from "node:path";
import type { Suggestion, ManifestEntry, ArtifactType } from "./types.js";
import { emit, type EmitTarget } from "./emit/index.js";
import { assertInside } from "./security.js";
import { addEntry, loadManifest } from "./manifest.js";
import { safeWriteFile } from "./safeFs.js";

export interface ApplyResult {
  suggestion: Suggestion;
  written?: string;
  printed?: string;
}

async function isTrackedTarget(projectDir: string, name: string, target: string): Promise<boolean> {
  const resolvedTarget = resolve(target);
  return (await loadManifest(projectDir)).some(entry => {
    if (entry.name !== name || !entry.path) return false;
    const entryPath = isAbsolute(entry.path) ? entry.path : join(projectDir, entry.path);
    return resolve(entryPath) === resolvedTarget;
  });
}

export async function applySuggestion(
  s: Suggestion,
  projectDir: string,
  opts: { emitTarget?: EmitTarget } = {},
): Promise<ApplyResult> {
  const result = emit(s, { target: opts.emitTarget });
  let type: ArtifactType;
  let written: string | undefined;
  let printed: string | undefined;

  if (result.kind === "command" || result.kind === "skill") {
    const abs = join(projectDir, result.path);
    assertInside(join(projectDir, ".claude"), abs);
    if (await isTrackedTarget(projectDir, s.name, abs)) {
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
    type = result.kind;
  } else if (result.kind === "loop") {
    printed = result.command;
    type = "loop";
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
  return { suggestion: s, written, printed };
}
