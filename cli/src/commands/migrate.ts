import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { addEntry, artifactHasMarker, artifactMarker, loadManifest } from "../core/manifest.js";
import { assertInside, sanitizeName } from "../core/security.js";
import { refreshRecallIndex } from "./recall.js";
import { safeReadFile, safeUnlink, safeWriteFile } from "../core/safeFs.js";
import {
  approvalMatches,
  loadArtifactApprovals,
  recordArtifactApproval,
} from "../core/approvals.js";

const MIGRATION_ARTIFACT_MAX_BYTES = 1_000_000;

export interface MigrateResult {
  migrated: string[];
  skipped: string[];
}

/** Split a legacy command into its description and body without requiring a
 * full YAML parser. Gradient emitted either a JSON string scalar or raw text. */
export function splitCommandFile(raw: string): { description: string; body: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!frontmatter) return { description: "", body: raw };

  const descriptionLine = frontmatter[1]
    .split(/\r?\n/)
    .find(line => /^\s*description\s*:/.test(line));
  let description = descriptionLine?.replace(/^\s*description\s*:\s*/, "") ?? "";
  if (description.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(description);
      if (typeof parsed === "string") description = parsed;
    } catch {
      // Keep malformed legacy frontmatter as plain description text.
    }
  }
  return { description, body: raw.slice(frontmatter[0].length) };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Convert only manifest-tracked command files into model-invokable skills. */
export async function migrate(
  projectDir: string,
  opts: { dryRun?: boolean; home?: string } = {},
): Promise<MigrateResult> {
  const migrated: string[] = [];
  const skipped: string[] = [];
  const claudeDir = join(projectDir, ".claude");
  const approvals = await loadArtifactApprovals(projectDir, opts.home);

  for (const entry of await loadManifest(projectDir)) {
    if (entry.type !== "command" || !entry.path) continue;

    const oldPath = isAbsolute(entry.path) ? entry.path : join(projectDir, entry.path);
    try {
      assertInside(claudeDir, oldPath);
    } catch {
      skipped.push(entry.name);
      continue;
    }

    let raw: string;
    try {
      raw = await safeReadFile(projectDir, oldPath, { maxBytes: MIGRATION_ARTIFACT_MAX_BYTES });
    } catch {
      skipped.push(entry.name);
      continue;
    }
    if (!artifactHasMarker(raw, entry)) {
      skipped.push(entry.name);
      continue;
    }
    // A 0.1.0 marker did not imply that the exact body was reviewed under the
    // hardened generator. Refuse to turn legacy/unapproved commands into
    // model-invokable skills; users can re-scan and re-apply them explicitly.
    if (!approvalMatches(approvals, entry, raw)) {
      skipped.push(entry.name);
      continue;
    }

    const name = sanitizeName(entry.name);
    const skillPath = join(claudeDir, "skills", name, "SKILL.md");
    assertInside(claudeDir, skillPath);

    // Never overwrite a hand-written (untracked) skill that happens to share a
    // generated command's name.
    if (await pathExists(skillPath)) {
      skipped.push(entry.name);
      continue;
    }

    migrated.push(entry.name);
    if (opts.dryRun) continue;

    const { description, body } = splitCommandFile(raw);
    const cleanBody = body.replace(/^<!-- gradient:generated[^\n]*-->\r?\n/, "");
    const bodyWithNewline = cleanBody.endsWith("\n") ? cleanBody : `${cleanBody}\n`;
    const markedContent =
      `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n` +
      `${artifactMarker(entry)}\n${bodyWithNewline}`;
    try {
      await safeWriteFile(projectDir, skillPath, markedContent, { exclusive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        migrated.pop();
        skipped.push(entry.name);
        continue;
      }
      throw error;
    }

    const migratedEntry = { ...entry, type: "skill" as const, path: skillPath };
    try {
      await addEntry(projectDir, migratedEntry);
      await recordArtifactApproval(projectDir, migratedEntry, markedContent, opts.home);
    } catch (error) {
      await addEntry(projectDir, entry).catch(() => undefined);
      await safeUnlink(projectDir, skillPath).catch(() => undefined);
      throw error;
    }
    await safeUnlink(projectDir, oldPath).catch(() => undefined);
  }

  if (!opts.dryRun && migrated.length > 0) {
    await refreshRecallIndex(projectDir, opts.home);
  }
  return { migrated, skipped };
}
