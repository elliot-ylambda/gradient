import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { safeReadFile } from "./safeFs.js";
import { locateRepo } from "./board.js";
import { assistantHomes, type DiscoveryOptions } from "./assistant-homes.js";

export { assistantHomes, type DiscoveryOptions } from "./assistant-homes.js";

export function within(base: string, path: string): boolean {
  const rel = relative(resolve(base), resolve(path));
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel));
}

/** At most 64 named ancestors; never a recursive home-directory search. */
export function ancestorDirs(dir: string, stop?: string): string[] {
  const out: string[] = [];
  let cursor = resolve(dir);
  for (let count = 0; count < 64; count++) {
    out.push(cursor);
    if (cursor === stop || dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  return out.reverse();
}

export async function repositoryDirs(projectDir: string): Promise<string[]> {
  const repo = await locateRepo(projectDir);
  if (!repo) return [resolve(projectDir)];
  // Git returns canonical paths. Match that spelling before walking upward,
  // otherwise an alias such as macOS /var would walk past the repository root.
  return ancestorDirs(await realpath(projectDir), repo.toplevel);
}

/** The canonical repository root, or the project directory outside Git. */
export async function projectRoot(projectDir: string): Promise<string> {
  const [root] = await repositoryDirs(projectDir);
  return realpath(root).catch(() => resolve(root));
}

/** The root a file found under `dir` must resolve inside: the project when the
 * discovery directory is in it, otherwise none. Judge the directory that was
 * walked, never the file, so a linked entry cannot place itself outside. */
export async function confineFor(project: string, dir: string): Promise<string | undefined> {
  // The parent too: a repository's own `.claude` may itself be a link.
  for (const candidate of [dir, dirname(dir)]) {
    if (within(project, await realpath(candidate).catch(() => resolve(candidate)))) return project;
  }
  return undefined;
}

/** Assistants follow linked instruction/skill files. Resolve only named files,
 * then use the bounded regular-file reader. Writes keep their no-symlink rule.
 * With `confine`, the file must also resolve inside it: a cloned repository
 * must not link an instruction or skill at the user's own files. */
export async function readDiscovered(path: string, maxBytes = 256_000, confine?: string): Promise<string> {
  const target = await realpath(path);
  if (confine && !within(confine, target)) {
    throw Object.assign(new Error("resolves outside the repository"), { code: "EOUTSIDE" });
  }
  return safeReadFile(dirname(target), target, { maxBytes });
}

export async function readSettings(path: string, warnings: string[], confine?: string): Promise<Record<string, any>> {
  try {
    const value: unknown = JSON.parse(await readDiscovered(path, 1_000_000, confine));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
    return value as Record<string, any>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`Could not inspect ${path}: ${(error as Error).message}`);
    return {};
  }
}

/** Imported memory is still assistant-managed state. Keep this ownership test
 * shared by inspection and the executor; an @import never authorizes editing it.
 * Claude documents autoMemoryDirectory in user/project/local settings, with
 * managed/--settings overrides remaining outside this local inventory. */
export async function managedMemoryGuard(
  projectDir: string,
  opts: DiscoveryOptions = {},
  warnings: string[] = [],
): Promise<(path: string) => Promise<boolean>> {
  const roots = assistantHomes(opts);
  const memoryRoots = new Set([join(roots.codex, "memories")]);
  const claudeProjects = new Set([join(roots.claude, "projects")]);
  const project = await projectRoot(projectDir);
  for (const path of [join(roots.claude, "settings.json"), ...(await repositoryDirs(projectDir))
    .flatMap(dir => [join(dir, ".claude", "settings.json"), join(dir, ".claude", "settings.local.json")])]) {
    const value = (await readSettings(path, warnings, await confineFor(project, dirname(path)))).autoMemoryDirectory;
    if (typeof value === "string" && value.startsWith("~/")) memoryRoots.add(join(roots.home, value.slice(2)));
    else if (typeof value === "string" && isAbsolute(value)) memoryRoots.add(resolve(value));
    else if (value !== undefined) warnings.push(`Could not resolve the managed memory directory configured in ${path}`);
  }
  // Retain both spellings so a missing leaf and an existing linked file are
  // protected consistently. This resolves only explicitly configured roots.
  for (const group of [memoryRoots, claudeProjects]) {
    for (const root of [...group]) {
      try { group.add(await realpath(root)); } catch { /* not created yet */ }
    }
  }
  const matches = (path: string): boolean => {
    if ([...memoryRoots].some(root => within(root, path))) return true;
    return [...claudeProjects].some(root => {
      const rel = relative(root, path).replaceAll("\\", "/");
      return /^[^/]+\/memory(?:\/|$)/.test(rel) && within(root, path);
    });
  };
  return async path => {
    if (matches(resolve(path))) return true;
    try { return matches(await realpath(path)); } catch { return false; }
  };
}
