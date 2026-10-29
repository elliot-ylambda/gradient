import { homedir } from "node:os";
import { join, basename, dirname, isAbsolute, resolve } from "node:path";
import { opendir, realpath } from "node:fs/promises";
import type { Assistant } from "./types.js";
import { ancestorDirs, assistantHomes, confineFor, projectRoot, readDiscovered, readSettings, repositoryDirs, within, type DiscoveryOptions } from "./discovery.js";
import { normalize, similarity } from "./cluster.js";
import { parseFrontmatter, scalar } from "./frontmatter.js";
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
  /** Description characters in the inspected inventory; not a token measurement. */
  contextChars: number;
  /** Known limits, skipped locations, and unreadable configuration. */
  warnings?: string[];
}

interface SkillDir {
  dir: string;
  base: string;
  assistant: Assistant;
  scope: "project" | "user";
  /** `.claude/commands/*.md` are flat files rather than directories. */
  flat?: boolean;
  namespace?: string;
}

async function skillDirs(projectDir: string, opts: DiscoveryOptions, targets: Assistant[], warnings: string[]): Promise<{ dirs: SkillDir[]; disabled: Set<string>; overrides: Record<string, unknown>; claudeSettings: Record<string, any> }> {
  const roots = assistantHomes(opts);
  const repoDirs = await repositoryDirs(projectDir);
  const project = await projectRoot(projectDir);
  const out: SkillDir[] = [];
  const disabled = new Set<string>();
  const overrides: Record<string, unknown> = {};
  const claudeSettings: Record<string, any> = {};
  if (targets.includes("claude-code")) {
    for (const [dir, scope] of [[roots.claude, "user"], ...ancestorDirs(projectDir).map(dir => [join(dir, ".claude"), "project"])] as Array<[string, "user" | "project"]>) {
      out.push({ dir: join(dir, "skills"), base: dir, assistant: "claude-code", scope });
      out.push({ dir: join(dir, "commands"), base: dir, assistant: "claude-code", scope, flat: true });
    }
    const enabled: Record<string, unknown> = {};
    for (const path of [join(roots.claude, "settings.json"), ...repoDirs.flatMap(dir => [join(dir, ".claude", "settings.json"), join(dir, ".claude", "settings.local.json")])]) {
      const settings = await readSettings(path, warnings, await confineFor(project, dirname(path)));
      Object.assign(claudeSettings, settings);
      if (settings.enabledPlugins && typeof settings.enabledPlugins === "object") Object.assign(enabled, settings.enabledPlugins);
      if (settings.skillOverrides && typeof settings.skillOverrides === "object") Object.assign(overrides, settings.skillOverrides);
    }
    const installed = await readSettings(join(roots.claude, "plugins", "installed_plugins.json"), warnings);
    const plugins = installed.plugins && typeof installed.plugins === "object" ? installed.plugins : {};
    for (const [id, isEnabled] of Object.entries(enabled).slice(0, MAX_SKILLS)) {
      if (isEnabled !== true || id.endsWith("@builtin")) continue;
      const records = Array.isArray(plugins[id]) ? plugins[id] as Array<Record<string, unknown>> : [];
      const eligible = records.filter(record => typeof record.installPath === "string" && isAbsolute(record.installPath) &&
        (record.scope === "user" || (typeof record.projectPath === "string" && repoDirs.some(dir => resolve(record.projectPath as string) === resolve(dir)))));
      const rank = (record: Record<string, unknown>) => record.scope === "local" ? 3 : record.scope === "project" ? 2 : 1;
      eligible.sort((a, b) => rank(b) - rank(a));
      const record = eligible[0];
      if (!record) { warnings.push(`Enabled Claude plugin ${id} has no applicable installation record; its skills were not inspected.`); continue; }
      const root = record.installPath as string;
      const manifest = await readSettings(join(root, ".claude-plugin", "plugin.json"), warnings);
      const namespace = typeof manifest.name === "string" ? manifest.name : id.split("@")[0];
      const extra = typeof manifest.skills === "string" ? [manifest.skills] : Array.isArray(manifest.skills) ? manifest.skills.filter((p: unknown): p is string => typeof p === "string") : [];
      for (const relative of ["skills", ...extra].slice(0, 32)) {
        const dir = resolve(root, relative);
        if (!within(root, dir)) { warnings.push(`Plugin ${id} skill path leaves its installation: ${relative}`); continue; }
        out.push({ dir, base: root, assistant: "claude-code", scope: record.scope === "user" ? "user" : "project", namespace });
      }
      out.push({ dir: join(root, "commands"), base: root, assistant: "claude-code", scope: record.scope === "user" ? "user" : "project", namespace, flat: true });
    }
    warnings.push("Claude built-in/account-synced/managed skills and command-line plugin or additional-directory overrides are not included.");
  }
  if (targets.includes("codex")) {
    for (const dir of repoDirs) out.push({ dir: join(dir, ".agents", "skills"), base: dir, assistant: "codex", scope: "project" });
    out.push(
      { dir: join(roots.home, ".agents", "skills"), base: roots.home, assistant: "codex", scope: "user" },
      { dir: join(roots.codex, "skills"), base: roots.codex, assistant: "codex", scope: "user" },
    );
    if (roots.home === resolve(homedir())) out.push({ dir: "/etc/codex/skills", base: "/etc/codex", assistant: "codex", scope: "user" });
    for (const path of [join(roots.codex, "config.toml"), ...repoDirs.map(dir => join(dir, ".codex", "config.toml"))]) {
      try {
        const config = await readDiscovered(path, undefined, await confineFor(project, dirname(path)));
        for (const section of config.split(/\[\[skills\.config\]\]/).slice(1)) {
          const block = section.split(/^\s*\[/m)[0];
          const name = /^path\s*=\s*["']([^"']+)["']/m.exec(block)?.[1];
          if (name && /^enabled\s*=\s*false\s*(?:#.*)?$/m.test(block)) {
            disabled.add(resolve(name));
            try { disabled.add(await realpath(name)); } catch { /* missing skill */ }
          }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not inspect skill enablement in ${path}`); }
    }
    warnings.push("Codex bundled/plugin skills, managed/profile overrides, and dynamically supplied skill locations are outside this inventory.");
  }
  return { dirs: out, disabled, overrides, claudeSettings };
}

async function entries(dir: string, warnings: string[]): Promise<string[]> {
  try {
    const handle = await opendir(dir);
    const out: string[] = [];
    for await (const entry of handle) {
      if (out.length >= MAX_SKILLS) { warnings.push(`Skills in ${dir} exceed the ${MAX_SKILLS}-entry inspection limit`); break; }
      out.push(entry.name);
    }
    return out.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not inspect skill directory ${dir}`);
    return [];
  }
}

async function readSkill(
  path: string,
  name: string,
  assistant: Assistant,
  scope: "project" | "user",
  warnings: string[],
  confine?: string,
): Promise<InstalledSkill | null> {
  let raw: string;
  try {
    raw = await readDiscovered(path, MAX_SKILL_BYTES, confine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not inspect skill ${path}: ${(error as Error).message}`);
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

  const authoredDescription = scalar(frontmatter, "description") ?? "";
  // Claude documents a body-line fallback; absence is not proof it cannot load.
  const fallback = assistant === "claude-code" ? raw.slice(frontmatter.length).split("\n").find(line => line.trim())?.trim() ?? "" : "";
  const description = authoredDescription || fallback;
  const whenToUse = scalar(frontmatter, "when_to_use") ?? "";
  const descriptionChars = description.length + whenToUse.length;
  if (!description) problems.push({ kind: "no-description" });
  else if (assistant === "claude-code" && descriptionChars > DESCRIPTION_CAP) {
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
async function memoryIndexPath(projectDir: string, home: string, claudeHome = join(home, ".claude")): Promise<string | null> {
  const repo = await locateRepo(projectDir);
  const root = repo?.root ?? projectDir;
  const candidates = [
    root.replace(/\//g, "-"),
    root.replace(/[/.]/g, "-"),
    root.replace(/[^a-zA-Z0-9]/g, "-"),
  ];
  for (const encoded of [...new Set(candidates)]) {
    const path = join(claudeHome, "projects", encoded, "memory", "MEMORY.md");
    try {
      await readDiscovered(path, MAX_MEMORY_BYTES);
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
export async function loadMemory(projectDir: string, home: string, claudeHome = join(home, ".claude"), memoryDirectory?: string): Promise<MemoryState | null> {
  const indexPath = memoryDirectory ? join(memoryDirectory, "MEMORY.md") : await memoryIndexPath(projectDir, home, claudeHome);
  if (!indexPath) return null;
  let raw: string;
  try {
    raw = await readDiscovered(indexPath, MAX_MEMORY_BYTES);
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
  opts: DiscoveryOptions = {},
): Promise<Surface> {
  const roots = assistantHomes(opts);
  const skills: InstalledSkill[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const inventory = await skillDirs(projectDir, opts, targets, warnings);
  const project = await projectRoot(projectDir);
  let candidates = 0;

  scan: for (const spec of inventory.dirs) {
    if (skills.length >= MAX_SKILLS) { warnings.push(`Skill inventory reached its ${MAX_SKILLS}-skill limit`); break; }
    const confine = await confineFor(project, spec.base);
    for (const entry of await entries(spec.dir, warnings)) {
      if (skills.length >= MAX_SKILLS) { warnings.push(`Skill inventory reached its ${MAX_SKILLS}-skill limit`); break; }
      if (spec.flat && !entry.endsWith(".md")) continue;
      if (entry.startsWith(".")) { if (entry !== ".DS_Store") warnings.push(`Hidden/system skill entry ${join(spec.dir, entry)} is outside the inventory`); continue; }
      if (++candidates > MAX_SKILLS * 4) { warnings.push(`Skill inspection reached its ${MAX_SKILLS * 4}-candidate limit`); break scan; }
      const path = spec.flat ? join(spec.dir, entry) : join(spec.dir, entry, "SKILL.md");
      if (inventory.disabled.has(resolve(path))) continue;
      const name = spec.flat ? basename(entry, ".md") : entry;
      if (!spec.namespace && spec.assistant === "claude-code" && inventory.overrides[name] === "off") continue;
      try {
        const canonical = await realpath(path);
        if (inventory.disabled.has(canonical)) continue;
        const key = `${spec.assistant}:${canonical}`;
        if (seen.has(key)) continue;
        seen.add(key);
      } catch { /* readSkill reports unreadable files and skips absent ones */ }
      const skill = await readSkill(path, spec.namespace ? `${spec.namespace}:${name}` : name, spec.assistant, spec.scope, warnings, confine);
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

  const memorySetting = inventory.claudeSettings.autoMemoryDirectory;
  const memoryDirectory = typeof memorySetting === "string" && memorySetting.startsWith("~/") ? join(roots.home, memorySetting.slice(2))
    : typeof memorySetting === "string" && isAbsolute(memorySetting) ? memorySetting : undefined;
  if (memorySetting !== undefined && !memoryDirectory) warnings.push("The configured Claude autoMemoryDirectory could not be resolved; auto memory was not inspected.");
  return {
    skills,
    memory: targets.includes("claude-code") && inventory.claudeSettings.autoMemoryEnabled !== false && (memorySetting === undefined || memoryDirectory)
      ? await loadMemory(projectDir, roots.home, roots.claude, memoryDirectory) : null,
    contextChars: skills.reduce((total, skill) => total + skill.descriptionChars, 0),
    warnings: [...new Set(warnings)],
  };
}

/** Description text found in the bounded inventory, not measured session cost. */
export function describeContextCost(surface: Surface): string {
  const skills = surface.skills.length;
  return `${skills} skill(s) · ${surface.contextChars} description chars inventoried`;
}
