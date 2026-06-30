import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Turn } from "../core/types.js";
import { parseFile } from "../core/parse.js";
import { filterPrompts } from "../core/filter.js";

export interface CheckpointInput { transcript_path?: string }

export async function checkpoint(
  input: CheckpointInput,
  projectDir: string,
  parseFn: (path: string) => Promise<Turn[]> = parseFile,
): Promise<string> {
  const turns = input.transcript_path ? await parseFn(input.transcript_path) : [];
  const prompts = filterPrompts(turns).slice(-10);
  const lines = prompts.map(p => `- ${p.text}`).join("\n");
  const md = `# Progress checkpoint\n\nRecent intents before compaction:\n\n${lines}\n`;
  const path = join(projectDir, "progress.md");
  await writeFile(path, md);
  return path;
}
