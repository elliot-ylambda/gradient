import { homedir } from "node:os";
import { join, relative } from "node:path";
import { lstat, opendir } from "node:fs/promises";
import type { Assistant } from "./types.js";
import { safeReadFile } from "./safeFs.js";
import { normalize } from "./cluster.js";
import { list, parseFrontmatter, type Frontmatter } from "./frontmatter.js";

/**
 * Every file the two assistants load as standing instructions, read-only.
 *
 * Which paths belong here is not a matter of taste — it is what each product
 * documents as auto-loaded, and getting it wrong in either direction is a bug.
 * A file gradient reads but the assistant does not is advice about nothing; a
 * file the assistant loads but gradient does not read is bloat gradient claims
 * to have checked and has not.
 */

const MAX_FILE_BYTES = 256_000;
const MAX_RULE_FILES = 200;
const MAX_RULE_DEPTH = 4;
const MIN_INSTRUCTION_CHARS = 8;
const MAX_INSTRUCTION_CHARS = 200;

export type InstructionScope = "project" | "user";
export type InstructionKind = "claude-md" | "claude-local" | "rule" | "agents-md";

export interface InstructionSource {
  path: string;
  scope: InstructionScope;
  assistant: Assistant;
  kind: InstructionKind;
  /** Lines in the file, for the documented under-200-lines guidance. */
  lineCount: number;
  bytes: number;
  /** Rules only: whether `paths:` frontmatter scopes when this file loads. */
  pathScoped?: boolean;
}

export interface InstructionLine {
  source: InstructionSource;
  /** 1-based, so it can be quoted back to the user as `file:line`. */
  line: number;
  text: string;
  normalized: string;
}

/**
 * Claude Code reads CLAUDE.md and not AGENTS.md. When a repository has both
 * assistants' users in it, the documented fix is a single `@AGENTS.md` import
 * at the top of CLAUDE.md (or a symlink), after which one file serves both.
 */
export interface BridgeState {
  claudeMdPath: string;
  agentsMdPath: string;
  claudeMdExists: boolean;
  agentsMdExists: boolean;
  importsAgentsMd: boolean;
  symlinked: boolean;
}

export interface InstructionSet {
  sources: InstructionSource[];
  lines: InstructionLine[];
  bridge: BridgeState;
  /** Paths that exist but could not be read, so a caller can say so rather
   *  than silently reporting a clean bill of health. */
  unreadable: string[];
}

/** Candidate instruction files per assistant, in load order. */
function candidatePaths(projectDir: string, home: string, assistant: Assistant): Array<{
  path: string; scope: InstructionScope; kind: InstructionKind; base: string;
}> {
  if (assistant === "codex") {
    return [
      { path: join(home, ".codex", "AGENTS.md"), scope: "user", kind: "agents-md", base: home },
      { path: join(projectDir, "AGENTS.md"), scope: "project", kind: "agents-md", base: projectDir },
    ];
  }
  return [
    { path: join(home, ".claude", "CLAUDE.md"), scope: "user", kind: "claude-md", base: home },
    { path: join(projectDir, "CLAUDE.md"), scope: "project", kind: "claude-md", base: projectDir },
    { path: join(projectDir, ".claude", "CLAUDE.md"), scope: "project", kind: "claude-md", base: projectDir },
    { path: join(projectDir, "CLAUDE.local.md"), scope: "project", kind: "claude-local", base: projectDir },
  ];
}

/** Recursively collect `*.md` under a rules directory. Symlinks are followed by
 *  Claude Code but not by gradient: a link can leave the tree entirely, and a
 *  read-only audit is not worth that reach. */
async function ruleFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_RULE_DEPTH) return [];
  let entries;
  try {
    entries = await opendir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for await (const entry of entries) {
    if (out.length >= MAX_RULE_FILES) break;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await ruleFiles(full, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out.slice(0, MAX_RULE_FILES);
}

/**
 * Instruction-bearing lines: markdown list items and short standalone
 * paragraph lines. Headings are labels, fenced code is content, and gradient's
 * own marker comments are not instructions at all.
 */
export function extractLines(raw: string, source: InstructionSource): InstructionLine[] {
  const out: InstructionLine[] = [];
  const frontmatter = parseFrontmatter(raw);
  const body = frontmatter.present ? raw.slice(frontmatter.length) : raw;
  const offset = frontmatter.present ? raw.slice(0, frontmatter.length).split("\n").length - 1 : 0;

  let fence: string | null = null;
  const bodyLines = body.split("\n");
  for (let index = 0; index < bodyLines.length; index++) {
    const trimmed = bodyLines[index].trim();

    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      if (fence && trimmed.startsWith(fence)) fence = null;
      else if (!fence) fence = fenceMatch[1];
      continue;
    }
    if (fence) continue;
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--")) continue;
    if (trimmed.startsWith("|") || /^[-*_]{3,}$/.test(trimmed)) continue;

    const text = trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();
    if (text.length < MIN_INSTRUCTION_CHARS || text.length > MAX_INSTRUCTION_CHARS) continue;
    // A line that is only a link or only an @import carries no instruction.
    if (/^!?\[[^\]]*\]\([^)]*\)$/.test(text) || /^@\S+$/.test(text)) continue;

    const normalized = normalize(text);
    if (!normalized) continue;
    out.push({ source, line: offset + index + 1, text, normalized });
  }
  return out;
}

/**
 * Whether CLAUDE.md imports AGENTS.md.
 *
 * Import parsing skips code spans and fenced blocks, and a backticked `@path`
 * is documented as staying literal — so a CLAUDE.md that *mentions*
 * `` `@AGENTS.md` `` while explaining the convention is not bridged, and must
 * still be offered the bridge.
 */
export function importsAgentsMd(raw: string): boolean {
  let fence: string | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      if (fence && trimmed.startsWith(fence)) fence = null;
      else if (!fence) fence = fenceMatch[1];
      continue;
    }
    if (fence) continue;
    // Strip code spans before looking for the import.
    const bare = line.replace(/`[^`]*`/g, " ");
    if (/(^|\s)@(?:\.\/)?AGENTS\.md(\s|$)/.test(bare)) return true;
  }
  return false;
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function readBounded(base: string, path: string): Promise<string | null> {
  try {
    return await safeReadFile(base, path, { maxBytes: MAX_FILE_BYTES });
  } catch {
    return null;
  }
}

export async function loadInstructions(
  projectDir: string,
  targets: Assistant[],
  opts: { home?: string } = {},
): Promise<InstructionSet> {
  const home = opts.home ?? homedir();
  const sources: InstructionSource[] = [];
  const lines: InstructionLine[] = [];
  const unreadable: string[] = [];

  const ingest = async (
    path: string,
    base: string,
    scope: InstructionScope,
    assistant: Assistant,
    kind: InstructionKind,
  ): Promise<void> => {
    let raw: string;
    try {
      raw = await safeReadFile(base, path, { maxBytes: MAX_FILE_BYTES });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(path);
      return;
    }
    const frontmatter: Frontmatter = parseFrontmatter(raw);
    const source: InstructionSource = {
      path,
      scope,
      assistant,
      kind,
      lineCount: raw.split("\n").length,
      bytes: Buffer.byteLength(raw, "utf8"),
      ...(kind === "rule" ? { pathScoped: list(frontmatter, "paths").length > 0 } : {}),
    };
    sources.push(source);
    lines.push(...extractLines(raw, source));
  };

  for (const assistant of targets) {
    for (const entry of candidatePaths(projectDir, home, assistant)) {
      await ingest(entry.path, entry.base, entry.scope, assistant, entry.kind);
    }
    if (assistant !== "claude-code") continue;
    for (const [dir, base, scope] of [
      [join(projectDir, ".claude", "rules"), projectDir, "project"],
      [join(home, ".claude", "rules"), home, "user"],
    ] as const) {
      for (const path of await ruleFiles(dir)) {
        await ingest(path, base, scope, assistant, "rule");
      }
    }
  }

  const claudeMdPath = join(projectDir, "CLAUDE.md");
  const agentsMdPath = join(projectDir, "AGENTS.md");
  const claudeMd = await readBounded(projectDir, claudeMdPath);
  const agentsMd = await readBounded(projectDir, agentsMdPath);
  const bridge: BridgeState = {
    claudeMdPath,
    agentsMdPath,
    claudeMdExists: claudeMd !== null,
    agentsMdExists: agentsMd !== null,
    importsAgentsMd: claudeMd !== null && importsAgentsMd(claudeMd),
    symlinked: await isSymlink(claudeMdPath),
  };

  return { sources, lines, bridge, unreadable };
}

/** Project-relative display path, falling back to the absolute path when the
 *  file lives outside the project (user scope). */
export function displayPath(path: string, projectDir: string): string {
  const rel = relative(projectDir, path);
  return rel && !rel.startsWith("..") ? rel : path;
}
