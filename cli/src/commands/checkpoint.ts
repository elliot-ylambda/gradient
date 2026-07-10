import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Turn } from "../core/types.js";
import { parseFile } from "../core/parse.js";
import { filterPrompts } from "../core/filter.js";
import { readTranscriptLines, renderTail } from "../core/tail.js";
import { redact } from "../core/security.js";

export interface CheckpointInput { transcript_path?: string }

export async function checkpoint(
  input: CheckpointInput,
  projectDir: string,
  parseFn: (path: string) => Promise<Turn[]> = parseFile,
  readLinesFn: (path: string) => Promise<string[]> = readTranscriptLines,
): Promise<string> {
  const turns = input.transcript_path ? await parseFn(input.transcript_path) : [];
  const prompts = filterPrompts(turns).slice(-10);
  const lines = prompts.map(prompt => `- ${redact(prompt.text ?? "")}`).join("\n");
  let tail = "";
  if (input.transcript_path) {
    try {
      const transcriptLines = (await readLinesFn(input.transcript_path)).map(redact);
      tail = redact(renderTail(transcriptLines, { maxTurns: 6, maxChars: 1500 }));
    } catch {
      // The richer tail is best-effort; recent intents still make a valid checkpoint.
    }
  }
  const md = `# Progress checkpoint\n\nRecent intents before compaction:\n\n${lines}\n` +
    (tail ? `\n## Where things stood\n\n${tail}\n` : "");
  const path = join(projectDir, "progress.md");
  await writeFile(path, md);
  return path;
}
