import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { parseLines } from "../core/parse.js";
import { filterPrompts } from "../core/filter.js";
import { fingerprint, readTranscriptLines } from "../core/tail.js";
import { assertInside, redact } from "../core/security.js";
import { assertNoSymlinkPath, safeWriteFile } from "../core/safeFs.js";
import { homedir } from "node:os";
import { loadConfig, projectCacheDir, projectKey } from "../config.js";

export interface CheckpointInput { transcript_path?: string }

export function progressPath(projectDir: string, home?: string): string {
  return join(projectCacheDir(projectDir, home), "progress.md");
}

export async function checkpoint(
  input: CheckpointInput,
  projectDir: string,
  readLinesFn: (path: string) => Promise<string[]> = readTranscriptLines,
  opts: { home?: string; consent?: boolean } = {},
): Promise<string | null> {
  const consented = opts.consent ??
    (await loadConfig(opts.home)).continuityProjects?.includes(projectKey(projectDir)) === true;
  if (!consented) return null;
  const userHome = opts.home ?? homedir();
  let transcriptLines: string[] = [];
  if (input.transcript_path) {
    const transcriptRoot = join(userHome, ".claude", "projects");
    assertInside(transcriptRoot, input.transcript_path);
    await assertNoSymlinkPath(userHome, input.transcript_path);
    if (!(await lstat(input.transcript_path)).isFile()) {
      throw new Error("refusing non-file transcript path");
    }
    transcriptLines = await readLinesFn(input.transcript_path);
  }
  const prompts = filterPrompts(parseLines(transcriptLines)).slice(-10);
  const lines = prompts
    .map(prompt => `- ${redact(prompt.text ?? "").slice(0, 500)}`)
    .join("\n");
  const activity = fingerprint(transcriptLines);
  const md = `# Progress checkpoint\n\nRecent intents before compaction:\n\n${lines}\n` +
    `\n## Activity\n\n- ${activity}\n`;
  const path = progressPath(projectDir, userHome);
  await safeWriteFile(userHome, path, md);
  return path;
}
