import { opendir } from "node:fs/promises";
import { join } from "node:path";
import { normalize } from "./cluster.js";
import { assertNoSymlinkPath, safeReadFile } from "./safeFs.js";

export interface InstructionLine {
  source: "project" | "project-local" | "rule" | "user";
  file: string;
  text: string;
  normalized: string;
}

const MIN_INSTRUCTION_CHARS = 8;
const MAX_INSTRUCTION_CHARS = 200;
const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;
const MAX_INSTRUCTIONS_PER_FILE = 500;
const MAX_RULE_FILES = 200;
const MAX_INSTRUCTIONS_TOTAL = 2_000;
const LIST_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/;
const LINK_ONLY_RE = /^(?:!?\[[^\]]*\]\([^)]+\)|<https?:\/\/[^>]+>|https?:\/\/\S+)$/i;

/** Extract short markdown instruction units without evaluating imports or
 * ingesting metadata, generated regions, quoted prose, or fenced examples. */
export function extractInstructionLines(markdown: string): string[] {
  const out: string[] = [];
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  let inFence = false;
  let inFrontmatter = lines[0]?.trim() === "---";
  let inHtmlComment = false;
  let inGradientRegion = false;

  for (let index = 0; index < lines.length && out.length < MAX_INSTRUCTIONS_PER_FILE; index++) {
    const line = lines[index].trim();
    if (inFrontmatter) {
      if (index > 0 && line === "---") inFrontmatter = false;
      continue;
    }
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/<!--\s*gradient:(?:mined:start|generated)\b/i.test(line)) {
      inGradientRegion = true;
      continue;
    }
    if (/<!--\s*gradient:mined:end\s*-->/i.test(line)) {
      inGradientRegion = false;
      continue;
    }
    if (inGradientRegion) continue;

    if (inHtmlComment) {
      if (line.includes("-->")) inHtmlComment = false;
      continue;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) inHtmlComment = true;
      continue;
    }
    if (!line || line.startsWith("#") || line.startsWith("|") || line.startsWith(">") ||
      /^@\S+$/.test(line) || LINK_ONLY_RE.test(line)) continue;

    const list = LIST_RE.exec(line);
    const text = (list?.[1] ?? line).replace(/^\[[ xX]\]\s+/, "").trim();
    if (text.length < MIN_INSTRUCTION_CHARS || text.length > MAX_INSTRUCTION_CHARS) continue;
    out.push(text);
  }
  return out;
}

async function fileLines(
  base: string,
  source: InstructionLine["source"],
  file: string,
): Promise<InstructionLine[]> {
  try {
    const markdown = await safeReadFile(base, file, { maxBytes: MAX_INSTRUCTION_FILE_BYTES });
    return extractInstructionLines(markdown)
      .map(text => ({ source, file, text, normalized: normalize(text) }))
      .filter(line => line.normalized.length > 0);
  } catch {
    return [];
  }
}

export async function loadInstructions(projectDir: string, home: string): Promise<InstructionLine[]> {
  const instructions: InstructionLine[] = [
    ...(await fileLines(projectDir, "project", join(projectDir, "CLAUDE.md"))),
    ...(await fileLines(projectDir, "project-local", join(projectDir, "CLAUDE.local.md"))),
    ...(await fileLines(home, "user", join(home, ".claude", "CLAUDE.md"))),
  ];

  const rulesDir = join(projectDir, ".claude", "rules");
  try {
    await assertNoSymlinkPath(projectDir, rulesDir);
    const directory = await opendir(rulesDir);
    const names: string[] = [];
    try {
      for await (const entry of directory) {
        if (names.length >= MAX_RULE_FILES) break;
        if (entry.isFile() && entry.name.endsWith(".md")) names.push(entry.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    names.sort();
    for (const name of names) {
      if (instructions.length >= MAX_INSTRUCTIONS_TOTAL) break;
      instructions.push(...(await fileLines(projectDir, "rule", join(rulesDir, name))));
    }
  } catch {
    // Missing, unreadable, oversized, or symlinked sources contribute nothing.
  }

  return instructions.slice(0, MAX_INSTRUCTIONS_TOTAL);
}
