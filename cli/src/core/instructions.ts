import { dirname, join, relative, resolve } from "node:path";
import { lstat, opendir, realpath } from "node:fs/promises";
import type { Assistant } from "./types.js";
import { ancestorDirs, assistantHomes, confineFor, managedMemoryGuard, projectRoot, readDiscovered, readSettings, repositoryDirs, type DiscoveryOptions } from "./discovery.js";
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
  /** Assistant-managed memory remains read-only even when explicitly imported. */
  readOnly?: boolean;
  /** The file behind `path`: a CLAUDE.md symlinked to AGENTS.md is one file
   *  that both assistants load. */
  realPath?: string;
}

export interface InstructionLine {
  source: InstructionSource;
  /** 1-based, so it can be quoted back to the user as `file:line`. */
  line: number;
  text: string;
  normalized: string;
}

/** Claude AGENTS.md loading depends on instruction mode and ancestor files. */
export interface BridgeState {
  claudeMdPath: string;
  agentsMdPath: string;
  claudeMdExists: boolean;
  agentsMdExists: boolean;
  importsAgentsMd: boolean;
  symlinked: boolean;
  claudeLoadsAgentsMd?: boolean;
  codexLoadsAgentsMd?: boolean;
  mode?: "claude-md-or-agents-md" | "claude-md-and-agents-md" | "claude-md" | "managed-only" | "unknown";
  blockedBy?: string[];
}

export interface InstructionSet {
  sources: InstructionSource[];
  lines: InstructionLine[];
  bridge: BridgeState;
  /** Paths that exist but could not be read, so a caller can say so rather
   *  than silently reporting a clean bill of health. */
  unreadable: string[];
  /** Bounds and runtime-specific configuration the inventory cannot establish. */
  warnings?: string[];
  /** Codex stops reading instruction files at `project_doc_max_bytes`; the
   *  file where it stopped, and how much of it was read. */
  codexBudget?: { path: string; bytes: number; budget: number; loaded: number };
}

/** Bounded rules traversal, including documented symlink folders. */
async function ruleFiles(dir: string, warnings: string[], seen = new Set<string>(), depth = 0): Promise<string[]> {
  if (depth > MAX_RULE_DEPTH) { warnings.push(`Rules below ${dir} exceed the ${MAX_RULE_DEPTH}-level inspection limit`); return []; }
  let entries;
  try {
    const canonical = await realpath(dir);
    if (seen.has(canonical)) return [];
    seen.add(canonical);
    entries = await opendir(canonical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not inspect rules in ${dir}`);
    return [];
  }
  const out: string[] = [];
  for await (const entry of entries) {
    if (out.length >= MAX_RULE_FILES) { warnings.push(`Rules in ${dir} exceed the ${MAX_RULE_FILES}-file inspection limit`); break; }
    const full = join(dir, entry.name);
    let directory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { directory = (await lstat(await realpath(full))).isDirectory(); } catch { continue; }
    }
    if (directory) out.push(...await ruleFiles(full, warnings, seen, depth + 1));
    else if (entry.name.endsWith(".md")) out.push(full);
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

/** Confined to `project` when the directory holding `path` is inside it. */
async function readBounded(project: string, path: string, unreadable?: string[]): Promise<string | null> {
  try {
    return await readDiscovered(path, MAX_FILE_BYTES, await confineFor(project, dirname(path)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable?.push(path);
    return null;
  }
}

/** Current documented Claude instruction setting. Project/local settings do not
 * control it: https://code.claude.com/docs/en/memory#choose-which-instruction-files-load */
function instructionMode(settings: Record<string, any>): NonNullable<BridgeState["mode"]> {
  const ids = ["cc-plugin-agents-md@builtin", "agents-md@builtin"];
  if (ids.some(id => settings.enabledPlugins?.[id] === false)) return "claude-md";
  const value = ids.map(id => settings.pluginConfigs?.[id]?.options?.instructionFiles).find(value => value !== undefined);
  if (value === undefined) return "claude-md-or-agents-md";
  return ["claude-md-or-agents-md", "claude-md-and-agents-md", "claude-md", "managed-only"].includes(value) ? value : "unknown";
}

function importedPaths(raw: string, from: string, home: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of raw.split("\n")) {
    const match = /^\s*(```+|~~~+)/.exec(line);
    if (match) { fence = fence ? null : match[1]; continue; }
    if (fence) continue;
    const bare = line.replace(/`[^`]*`/g, " ");
    for (const match of bare.matchAll(/(?:^|\s)@([^\s`<>]+)/g)) {
      const name = match[1];
      if (name.includes("://")) continue;
      out.push(name.startsWith("~/") ? join(home, name.slice(2)) : resolve(dirname(from), name));
    }
  }
  return out.slice(0, 100);
}

export async function loadInstructions(
  projectDir: string,
  targets: Assistant[],
  opts: DiscoveryOptions = {},
): Promise<InstructionSet> {
  const roots = assistantHomes(opts);
  const sources: InstructionSource[] = [];
  const lines: InstructionLine[] = [];
  const unreadable: string[] = [];
  const warnings: string[] = [];
  let codexBudget: InstructionSet["codexBudget"];
  const seen = new Set<string>();
  const ancestors = ancestorDirs(projectDir);
  const repoDirs = await repositoryDirs(projectDir);
  const project = await projectRoot(projectDir);
  const isManagedMemory = await managedMemoryGuard(projectDir, opts, warnings);
  const settings = targets.includes("claude-code") ? await readSettings(join(roots.claude, "settings.json"), warnings) : {};
  const configuredMode = instructionMode(settings);
  const mode = settings.claudeMdExcludes?.length && configuredMode !== "managed-only" ? "unknown" : configuredMode;
  const claudeCandidates = ancestors.flatMap(dir => [
    { path: join(dir, "CLAUDE.md"), kind: "claude-md" as const },
    { path: join(dir, ".claude", "CLAUDE.md"), kind: "claude-md" as const },
    { path: join(dir, "CLAUDE.local.md"), kind: "claude-local" as const },
  ]);
  const blockedBy: string[] = [];
  for (const entry of claudeCandidates) {
    if (entry.path === join(roots.claude, "CLAUDE.md")) continue;
    if (await readBounded(project, entry.path, unreadable) !== null) blockedBy.push(entry.path);
  }

  // `confine` comes from the directory walked; an @import inherits its
  // importer's, so a repository file cannot import the user's own files.
  // Claude Code asks before loading such an external import.
  const ingest = async (
    path: string, scope: InstructionScope, assistant: Assistant, kind: InstructionKind, depth = 0,
    confine?: string,
  ): Promise<void> => {
    if (depth > 5 || sources.length >= 500) { warnings.push(`Instruction inspection limit reached at ${path}`); return; }
    if (depth === 0) confine ??= await confineFor(project, dirname(path));
    let raw: string;
    let canonical: string;
    try {
      canonical = await realpath(path);
      const key = `${assistant}:${canonical}`;
      if (seen.has(key)) return;
      raw = await readDiscovered(path, MAX_FILE_BYTES, confine);
      seen.add(key);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EOUTSIDE") {
        warnings.push(`${path} is outside the repository and was not inspected; Claude Code asks before loading a repository's external import or link.`);
      } else if (code !== "ENOENT" || depth > 0) unreadable.push(path);
      return;
    }
    const frontmatter: Frontmatter = parseFrontmatter(raw);
    const source: InstructionSource = {
      path, scope, assistant, kind, realPath: canonical,
      lineCount: raw.split("\n").length,
      bytes: Buffer.byteLength(raw, "utf8"),
      ...(kind === "rule" ? { pathScoped: list(frontmatter, "paths").length > 0 } : {}),
      ...(await isManagedMemory(path) ? { readOnly: true } : {}),
    };
    sources.push(source);
    lines.push(...extractLines(raw, source));
    if (assistant === "claude-code") {
      for (const imported of importedPaths(raw, path, roots.home)) {
        await ingest(imported, scope, assistant, imported.endsWith("AGENTS.md") ? "agents-md" : kind, depth + 1, confine);
      }
    }
  };

  if (targets.includes("claude-code")) {
    warnings.push("Claude managed settings, command-line settings/additional directories, and lazy-loaded subdirectory instructions are outside this inventory; native AGENTS.md fallback assumes current Claude Code (2.1.281+).");
    if (settings.claudeMdExcludes?.length) warnings.push("Claude claudeMdExcludes filters are not evaluated; listed instruction files may be excluded in the session.");
    if (mode === "unknown") warnings.push("Unknown Claude instructionFiles setting; direct AGENTS.md loading could not be established.");
    if (mode !== "managed-only") {
      await ingest(join(roots.claude, "CLAUDE.md"), "user", "claude-code", "claude-md");
      for (const entry of claudeCandidates) await ingest(entry.path, "project", "claude-code", entry.kind);
      const nativeAgents = mode === "claude-md-and-agents-md" || (mode === "claude-md-or-agents-md" && blockedBy.length === 0);
      if (nativeAgents) {
        for (const dir of ancestors) {
          for (const path of [join(dir, "AGENTS.md"), join(dir, ".claude", "AGENTS.md")]) {
            await ingest(path, "project", "claude-code", "agents-md");
          }
        }
      }
      for (const [dir, scope] of [[join(roots.claude, "rules"), "user"], ...ancestors.map(dir => [join(dir, ".claude", "rules"), "project"])] as Array<[string, InstructionScope]>) {
        // Confined by the rules root: the walk follows linked subdirectories.
        const confine = await confineFor(project, dir);
        for (const path of await ruleFiles(dir, warnings)) await ingest(path, scope, "claude-code", "rule", 0, confine);
      }
    }
  }

  if (targets.includes("codex")) {
    // Top-level scalar/array settings only; no ad-hoc parsing of nested TOML.
    let fallback: string[] = [];
    let budget = 32 * 1024;
    for (const path of [join(roots.codex, "config.toml"), ...repoDirs.map(dir => join(dir, ".codex", "config.toml"))]) {
      const raw = await readBounded(project, path, unreadable);
      if (raw === null) continue;
      const top = raw.split(/^\s*\[/m)[0];
      const bytes = /^project_doc_max_bytes\s*=\s*(\d+)/m.exec(top);
      if (bytes) budget = Math.min(Number(bytes[1]), 1_000_000);
      const names = /^project_doc_fallback_filenames\s*=\s*(\[[^\]]*\])/m.exec(top);
      if (names) {
        try {
          const parsed: unknown = JSON.parse(names[1]);
          if (!Array.isArray(parsed) || !parsed.every(n => typeof n === "string" && n.length < 256 && !n.includes("/") && !n.includes("\\"))) throw new Error("unsupported names");
          fallback = parsed.slice(0, 32);
        } catch { warnings.push(`Could not interpret project_doc_fallback_filenames in ${path}; fallback files were not inspected.`); }
      }
    }
    let consumed = 0;
    for (const [dir, scope] of [[roots.codex, "user"], ...repoDirs.map(dir => [dir, "project"])] as Array<[string, InstructionScope]>) {
      for (const name of ["AGENTS.override.md", "AGENTS.md", ...(scope === "project" ? fallback : [])]) {
        const path = join(dir, name);
        const raw = await readBounded(project, path, unreadable);
        if (raw === null || !raw.trim()) continue;
        const size = Buffer.byteLength(raw);
        if (consumed + size > budget) {
          // Not audited as loaded: Codex never sees the rest. Reported as a
          // finding, because it is a fact about the setup, not about this check.
          codexBudget ??= { path, bytes: size, budget, loaded: budget - consumed };
          consumed = budget;
        } else if (consumed < budget) {
          await ingest(path, scope, "codex", "agents-md");
          consumed += size;
        }
        break;
      }
    }
    warnings.push("Codex managed/profile overrides and project trust are not resolved; instruction discovery uses local config files and the documented precedence.");
  }

  const claudeMdPath = join(projectDir, "CLAUDE.md");
  const agentsMdPath = join(projectDir, "AGENTS.md");
  const claudeMd = await readBounded(project, claudeMdPath, unreadable);
  const agentsMd = await readBounded(project, agentsMdPath, unreadable);
  const bridge: BridgeState = {
    claudeMdPath, agentsMdPath,
    claudeMdExists: claudeMd !== null,
    agentsMdExists: agentsMd !== null,
    importsAgentsMd: claudeMd !== null && importsAgentsMd(claudeMd),
    symlinked: await isSymlink(claudeMdPath),
    claudeLoadsAgentsMd: sources.some(s => s.assistant === "claude-code" && s.path === agentsMdPath),
    codexLoadsAgentsMd: sources.some(s => s.assistant === "codex" && s.path === agentsMdPath),
    mode, blockedBy,
  };

  return {
    sources, lines, bridge, unreadable: [...new Set(unreadable)], warnings: [...new Set(warnings)],
    ...(codexBudget ? { codexBudget } : {}),
  };
}

/** Project-relative display path, falling back to the absolute path when the
 *  file lives outside the project (user scope). */
export function displayPath(path: string, projectDir: string): string {
  const rel = relative(projectDir, path);
  return rel && !rel.startsWith("..") ? rel : path;
}
