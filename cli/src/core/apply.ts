import { writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Assistant, Suggestion, ManifestEntry, ArtifactType } from "./types.js";
import { emit, type EmitTarget } from "./emit/index.js";
import { assertInside } from "./security.js";
import { addEntry, loadManifest } from "./manifest.js";

export interface ApplyResult {
  suggestion: Suggestion;
  writes: { target: Assistant; path: string }[];
  skippedTargets: Assistant[];
  failures: { target: Assistant; error: string }[];
  /** First written path, retained for callers predating multi-target apply. */
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
  opts: { emitTarget?: EmitTarget; targets?: Assistant[]; cheapModel?: string } = {},
): Promise<ApplyResult> {
  const targets = opts.targets ?? ["claude-code"];
  const writes: ApplyResult["writes"] = [];
  const skippedTargets: Assistant[] = [];
  const failures: ApplyResult["failures"] = [];
  let printed: string | undefined;

  for (const target of targets) {
    if (target === "codex" && s.payload.type !== "command") {
      skippedTargets.push(target);
      continue;
    }

    try {
      const result = emit(s, {
        target: opts.emitTarget,
        assistant: target,
        cheapModel: opts.cheapModel,
      });
      let type: ArtifactType;
      let written = "";

      if (result.kind === "command" || result.kind === "skill" || result.kind === "rule") {
        const abs = join(projectDir, result.path);
        const root = target === "codex" ? ".agents" : ".claude";
        assertInside(join(projectDir, root), abs);
        await mkdir(dirname(abs), { recursive: true });
        if (await isTrackedTarget(projectDir, s.name, abs)) {
          await writeFile(abs, result.content);
        } else {
          try {
            await writeFile(abs, result.content, { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new Error(`refusing to overwrite untracked artifact: ${abs}`);
            }
            throw error;
          }
        }
        written = abs;
        writes.push({ target, path: abs });
        type = result.kind;
      } else if (result.kind === "loop") {
        printed = result.command;
        type = "loop";
      } else if (result.kind === "rule-print") {
        printed = result.text;
        type = "rule";
      } else {
        printed = result.settingsPatch;
        type = "hook";
      }

      const entry: ManifestEntry = {
        name: s.name,
        type,
        path: written,
        createdAt: new Date().toISOString().slice(0, 10),
        suggestionId: s.id,
        ...(target === "codex" ? { target } : {}),
      };
      await addEntry(projectDir, entry);
    } catch (error) {
      failures.push({ target, error: (error as Error).message });
    }
  }

  if (failures.length > 0 && writes.length === 0 && !printed) {
    throw new Error(failures.map(failure => `${failure.target}: ${failure.error}`).join("; "));
  }
  return {
    suggestion: s,
    writes,
    skippedTargets,
    failures,
    written: writes[0]?.path,
    printed,
  };
}
