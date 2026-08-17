import { homedir } from "node:os";
import { join, basename } from "node:path";
import { opendir } from "node:fs/promises";
import type { Assistant } from "./types.js";
import { safeReadFile } from "./safeFs.js";
import { normalize, similarity } from "./cluster.js";
import { list, parseFrontmatter, scalar } from "./frontmatter.js";
import { locateRepo } from "./board.js";

/**
 * What is actually installed, as opposed to what the manifest thinks is
 * installed.
 *
 * Skill descriptions are loaded into every session, so a skill's cost is paid
 * whether or not it is ever invoked, and the things that stop one from being
 * selected — an unreadable frontmatter key, a missing description, a
 * description past the listing cap — are structural facts rather than matters
 * of taste. That is what makes this checkable without a model.
 */

const MAX_SKILL_BYTES = 256_000;
const MAX_SKILLS = 500;
const MAX_MEMORY_BYTES = 512_000;

/** The combined `description` + `when_to_use` budget in the skill listing.
 *  Text past it is truncated, so it costs nothing and does nothing. */
export const DESCRIPTION_CAP = 1_536;

/** Auto-memory's index is loaded up to the first 200 lines or 25KB, whichever
 *  comes first. Everything after that never reaches a session. */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25_000;

const DUPLICATE_DESCRIPTION_THRESHOLD = 0.8;

/**
 * Every frontmatter key Claude Code documents.
 *
 * Claude Code tolerates keys outside this list — a skill carrying `version:`
 * and `requires:` loads and dispatches normally, which a dogfood run confirmed
 * against a real install. What such keys actually break is portability: the
 * Agent Skills spec defines six fields, and claude.ai uploads, the Skills API,
 * and `package_skill.py` reject anything else outright. So a non-standard key
 * is a portability finding, never a "this is broken here" finding.
 */
const CLAUDE_CODE_KEYS: ReadonlySet<string> = new Set([
  "name", "description", "when_to_use", "argument-hint", "arguments",
  "disable-model-invocation", "user-invocable", "allowed-tools", "disallowed-tools",
  "model", "effort", "context", "agent", "background", "hooks", "paths", "shell",
  "metadata", "license", "compatibility",
]);

/** The Agent Skills spec's six. A skill using only these loads anywhere —
 *  Claude Code, Codex, claude.ai, the Skills API. */
const PORTABLE_KEYS: ReadonlySet<string> = new Set([
  "name", "description", "license", "compatibility", "metadata", "allowed-tools",
]);

export type SkillProblem =
  | { kind: "unreadable-frontmatter"; detail: string }
  | { kind: "non-standard-key"; key: string }
  | { kind: "non-portable-key"; key: string }
  | { kind: "no-description" }
  | { kind: "description-over-cap"; chars: number }
  | { kind: "duplicate-description"; other: string };

export interface InstalledSkill {
  path: string;
  assistant: Assistant;
  scope: "project" | "user";
  /** The name the user types; comes from the directory (or file) name. */
  name: string;
  description: string;
  /** description + when_to_use, the text that counts against the listing cap. */
  descriptionChars: number;
  gradientOwned: boolean;
  problems: SkillProblem[];
}

export interface MemoryLine {
  line: number;
  text: string;
  normalized: string;
  /** True when this entry sits past the index's load limit. */
  beyondLimit: boolean;
}

export interface MemoryState {
  indexPath: string;
  lines: MemoryLine[];
  totalLines: number;
  bytes: number;
  overLineLimit: boolean;
  overByteLimit: boolean;
}

export interface Surface {
  skills: InstalledSkill[];
  /** Null when the project has no auto-memory index. Never written to. */
  memory: MemoryState | null;
  /** Description characters loaded into every session by installed skills. */
  contextChars: number;
}

interface SkillDir {
  dir: string;
  base: string;
  assistant: Assistant;
  scope: "project" | "user";
  /** `.claude/commands/*.md` are flat files rather than directories. */
  flat?: boolean;
}

function skillDirs(projectDir: string, home: string, targets: Assistant[]): SkillDir[] {
  const out: SkillDir[] = [];
  if (targets.includes("claude-code")) {
    out.push(
      { dir: join(projectDir, ".claude", "skills"), base: projectDir, assistant: "claude-code", scope: "project" },
      { dir: join(home, ".claude", "skills"), base: home, assistant: "claude-code", scope: "user" },
      { dir: join(projectDir, ".claude", "commands"), base: projectDir, assistant: "claude-code", scope: "project", flat: true },
    );
  }
  if (targets.includes("codex")) {
    out.push(
      { dir: join(projectDir, ".agents", "skills"), base: projectDir, assistant: "codex", scope: "project" },
      { dir: join(home, ".agents", "skills"), base: home, assistant: "codex", scope: "user" },
    );
  }
  return out;
}

async function entries(dir: string): Promise<string[]> {
  try {
    const handle = await opendir(dir);
    const out: string[] = [];
    for await (const entry of handle) {
      if (out.length >= MAX_SKILLS) break;
      out.push(entry.name);
    }
    return out;
  } catch {
    return [];
  }
}

async function readSkill(
  path: string,
  base: string,
  name: string,
  assistant: Assistant,
  scope: "project" | "user",
): Promise<InstalledSkill | null> {
  let raw: string;
  try {
    raw = await safeReadFile(base, path, { maxBytes: MAX_SKILL_BYTES });
  } catch {
    return null;
  }

  const frontmatter = parseFrontmatter(raw);
  const problems: SkillProblem[] = [];
  if (frontmatter.error) problems.push({ kind: "unreadable-frontmatter", detail: frontmatter.error });

  for (const key of frontmatter.keys) {
    // Outside both lists: no tool documents it, so it travels nowhere.
    if (!CLAUDE_CODE_KEYS.has(key) && !PORTABLE_KEYS.has(key)) {
      problems.push({ kind: "non-standard-key", key });
    // A documented Claude Code extension on a skill installed for Codex, which
    // follows the spec: the key is why that copy behaves differently there.
    } else if (assistant === "codex" && !PORTABLE_KEYS.has(key)) {
      problems.push({ kind: "non-portable-key", key });
    }
  }

  const description = scalar(frontmatter, "description") ?? "";
  const whenToUse = scalar(frontmatter, "when_to_use") ?? "";
  const descriptionChars = description.length + whenToUse.length;
  if (!description) problems.push({ kind: "no-description" });
  else if (descriptionChars > DESCRIPTION_CAP) {
    problems.push({ kind: "description-over-cap", chars: descriptionChars });
  }

  return {
    path,
    assistant,
    scope,
    name,
    description,
    descriptionChars,
    gradientOwned: raw.slice(0, 2_000).includes("<!-- gradient:"),
    problems,
  };
}

/** Auto-memory lives under the repository root, so every worktree shares one
 *  directory. The encoding of that root into a directory name is not
 *  documented, so candidates are tried rather than guessed at. */
async function memoryIndexPath(projectDir: string, home: string): Promise<string | null> {
  const repo = await locateRepo(projectDir);
  const root = repo?.root ?? projectDir;
  const candidates = [
    root.replace(/\//g, "-"),
    root.replace(/[/.]/g, "-"),
    root.replace(/[^a-zA-Z0-9]/g, "-"),
  ];
  for (const encoded of [...new Set(candidates)]) {
    const path = join(home, ".claude", "projects", encoded, "memory", "MEMORY.md");
    try {
      await safeReadFile(home, path, { maxBytes: MAX_MEMORY_BYTES });
      return path;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Read the auto-memory index. Read-only by design: Claude Code owns this
 * directory and manages it well, so gradient reports what it sees and never
 * edits or deletes a memory file.
 */
export async function loadMemory(projectDir: string, home: string): Promise<MemoryState | null> {
  const indexPath = await memoryIndexPath(projectDir, home);
  if (!indexPath) return null;
  let raw: string;
  try {
    raw = await safeReadFile(home, indexPath, { maxBytes: MAX_MEMORY_BYTES });
  } catch {
    return null;
  }

  const all = raw.split("\n");
  const bytes = Buffer.byteLength(raw, "utf8");
  // Where the byte budget runs out, so an entry can be told it never loads.
  let consumed = 0;
  let byteCutoff = all.length;
  for (let index = 0; index < all.length; index++) {
    consumed += Buffer.byteLength(all[index], "utf8") + 1;
    if (consumed > MEMORY_INDEX_MAX_BYTES) { byteCutoff = index; break; }
  }
  const cutoff = Math.min(MEMORY_INDEX_MAX_LINES, byteCutoff);

  const lines: MemoryLine[] = [];
  for (let index = 0; index < all.length; index++) {
    const trimmed = all[index].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const text = trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();
    const normalized = normalize(text);
    if (!normalized) continue;
    lines.push({ line: index + 1, text, normalized, beyondLimit: index >= cutoff });
  }

  return {
    indexPath,
    lines,
    totalLines: all.length,
    bytes,
    overLineLimit: all.length > MEMORY_INDEX_MAX_LINES,
    overByteLimit: bytes > MEMORY_INDEX_MAX_BYTES,
  };
}

export async function loadSurface(
  projectDir: string,
  targets: Assistant[],
  opts: { home?: string } = {},
): Promise<Surface> {
  const home = opts.home ?? homedir();
  const skills: InstalledSkill[] = [];

  for (const spec of skillDirs(projectDir, home, targets)) {
    for (const entry of await entries(spec.dir)) {
      if (spec.flat) {
        if (!entry.endsWith(".md")) continue;
        const skill = await readSkill(
          join(spec.dir, entry), spec.base, basename(entry, ".md"), spec.assistant, spec.scope);
        if (skill) skills.push(skill);
        continue;
      }
      const skill = await readSkill(
        join(spec.dir, entry, "SKILL.md"), spec.base, entry, spec.assistant, spec.scope);
      if (skill) skills.push(skill);
    }
  }

  // Two skills the model cannot tell apart are two skills it will pick between
  // arbitrarily. Compared within an assistant: the same skill installed for
  // both Claude Code and Codex is the intended arrangement, not a duplicate.
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i];
      const b = skills[j];
      if (a.assistant !== b.assistant || !a.description || !b.description) continue;
      if (a.name === b.name) continue;
      if (similarity(normalize(a.description), normalize(b.description)) < DUPLICATE_DESCRIPTION_THRESHOLD) continue;
      a.problems.push({ kind: "duplicate-description", other: b.name });
      b.problems.push({ kind: "duplicate-description", other: a.name });
    }
  }

  return {
    skills,
    memory: targets.includes("claude-code") ? await loadMemory(projectDir, home) : null,
    contextChars: skills.reduce((total, skill) => total + skill.descriptionChars, 0),
  };
}

/** Skill descriptions the assistant loads every session, as a share of the
 *  documented listing budget. Used for the one number worth reporting. */
export function describeContextCost(surface: Surface): string {
  const skills = surface.skills.length;
  return `${skills} skill(s) · ${surface.contextChars} description chars loaded every session`;
}
