import { isAbsolute, join, resolve } from "node:path";
import type { ArtifactType, Assistant, ManifestEntry, Suggestion } from "./types.js";
import { emit, type EmitTarget } from "./emit/index.js";
import { assertInside } from "./security.js";
import { addEntry, artifactHasMarker, loadManifest, manifestTarget } from "./manifest.js";
import { safeReadFile, safeUnlink, safeWriteFile } from "./safeFs.js";
import { installHook, removeHook } from "./settings.js";
import { validateSuggestion } from "./validate.js";
import { recordArtifactApproval } from "./approvals.js";

export interface ApplyResult {
  suggestion: Suggestion;
  writes: { target: Assistant; path: string }[];
  skippedTargets: Assistant[];
  failures: { target: Assistant; error: string }[];
  /** First written path, retained for callers predating multi-target apply. */
  written?: string;
  printed?: string;
}

async function trackedTarget(
  projectDir: string,
  suggestion: Suggestion,
  target: Assistant,
  path: string,
): Promise<ManifestEntry | undefined> {
  const resolvedTarget = resolve(path);
  return (await loadManifest(projectDir)).find(entry => {
    if (entry.name !== suggestion.name || manifestTarget(entry) !== target || !entry.path) return false;
    const entryPath = isAbsolute(entry.path) ? entry.path : join(projectDir, entry.path);
    return resolve(entryPath) === resolvedTarget;
  });
}

function normalizeTargets(value: Assistant[] | undefined): Assistant[] {
  const raw = value ?? ["claude-code"];
  const out: Assistant[] = [];
  for (const target of raw) {
    if (target !== "claude-code" && target !== "codex") throw new Error(`unsupported assistant target: ${String(target)}`);
    if (!out.includes(target)) out.push(target);
  }
  if (out.length === 0 || out.length > 2) throw new Error("apply requires one or two assistant targets");
  return out;
}

export async function applySuggestion(
  suggestion: Suggestion,
  projectDir: string,
  opts: {
    emitTarget?: EmitTarget;
    targets?: Assistant[];
    cheapModel?: string;
    home?: string;
  } = {},
): Promise<ApplyResult> {
  validateSuggestion(suggestion);
  if (suggestion.confidence === "flagged") {
    throw new Error("refusing to apply an unresolved flagged suggestion; resolve it through gradient review first");
  }
  const targets = normalizeTargets(opts.targets);
  const writes: ApplyResult["writes"] = [];
  const skippedTargets: Assistant[] = [];
  const failures: ApplyResult["failures"] = [];
  let printed: string | undefined;

  for (const target of targets) {
    if (target === "codex" && suggestion.payload.type !== "command" && suggestion.payload.type !== "rule") {
      skippedTargets.push(target);
      continue;
    }

    try {
      const result = emit(suggestion, {
        target: opts.emitTarget,
        assistant: target,
        cheapModel: opts.cheapModel,
      });
      let type: ArtifactType;
      let written = "";
      let approvalContent: string | undefined;
      let previousContent: string | undefined;
      let created = false;
      let installedHook: { event: string; command: string; settingsFile: string } | undefined;

      if (result.kind === "command" || result.kind === "skill" || result.kind === "rule") {
        const abs = join(projectDir, result.path);
        const assistantRoot = target === "codex" ? ".agents" : ".claude";
        assertInside(join(projectDir, assistantRoot), abs);
        const tracked = await trackedTarget(projectDir, suggestion, target, abs);
        if (tracked) {
          previousContent = await safeReadFile(projectDir, abs, { maxBytes: 1_000_000 });
          if (!artifactHasMarker(previousContent, tracked)) {
            throw new Error(`refusing to overwrite artifact without matching gradient provenance: ${abs}`);
          }
          await safeWriteFile(projectDir, abs, result.content, { mode: 0o600 });
        } else {
          try {
            await safeWriteFile(projectDir, abs, result.content, { exclusive: true, mode: 0o600 });
            created = true;
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
        type = "loop";
      } else if (result.kind === "rule-print") {
        type = "rule";
      } else {
        // Approval means installation: merge the hook into the project's
        // settings rather than printing JSON the user would have to hand-merge.
        if (suggestion.payload.type !== "hook") throw new Error("hook artifact requires a hook payload");
        const command = `gradient ${suggestion.payload.subcommand}`;
        const settingsFile = await installHook(projectDir, suggestion.payload.event, command, {
          ...(suggestion.payload.matcher !== undefined ? { matcher: suggestion.payload.matcher } : {}),
        });
        installedHook = { event: suggestion.payload.event, command, settingsFile };
        type = "hook";
      }

      const entry: ManifestEntry = {
        name: suggestion.name,
        type,
        path: written,
        createdAt: new Date().toISOString().slice(0, 10),
        suggestionId: suggestion.id,
        ...(target === "codex" ? { target } : {}),
        ...(installedHook ? { hook: { event: installedHook.event, command: installedHook.command } } : {}),
      };

      try {
        // The repo-local manifest and marker prove ownership, not human
        // approval. Record exact bytes in the private per-project ledger first;
        // a stale ledger entry is harmless if the manifest update then fails.
        if (written && approvalContent) {
          await recordArtifactApproval(projectDir, entry, approvalContent, opts.home);
        }
        await addEntry(projectDir, entry);
      } catch (error) {
        if (written) {
          if (created) await safeUnlink(projectDir, written).catch(() => undefined);
          else if (previousContent !== undefined) {
            await safeWriteFile(projectDir, written, previousContent, { mode: 0o600 }).catch(() => undefined);
          }
        }
        if (installedHook) {
          await removeHook(projectDir, installedHook.event, installedHook.command).catch(() => undefined);
        }
        throw error;
      }

      if (written) writes.push({ target, path: written });
      else if (installedHook) writes.push({ target, path: installedHook.settingsFile });
      const targetPrinted = result.kind === "loop"
        ? result.command
        : result.kind === "rule-print"
          ? result.text
          : undefined;
      if (targetPrinted) printed = [printed, targetPrinted].filter(Boolean).join("\n");
    } catch (error) {
      failures.push({ target, error: (error as Error).message });
    }
  }

  if (failures.length > 0 && writes.length === 0 && !printed) {
    throw new Error(failures.map(failure => `${failure.target}: ${failure.error}`).join("; "));
  }
  return {
    suggestion,
    writes,
    skippedTargets,
    failures,
    written: writes[0]?.path,
    printed,
  };
}
