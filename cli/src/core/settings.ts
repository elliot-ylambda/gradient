import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { assertInside } from "./security.js";

export function settingsPath(projectDir: string): string {
  return join(projectDir, ".claude", "settings.json");
}

interface HookGroup { hooks: { type: string; command: string; timeout?: number }[] }

export function mergeHookIntoSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
  opts: { timeout?: number } = {},
): Record<string, any> {
  const out = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const groups: HookGroup[] = Array.isArray(out.hooks[event]) ? [...out.hooks[event]] : [];
  const already = groups.some(g => g.hooks?.some(h => h.command === command));
  if (!already) {
    const hook: { type: string; command: string; timeout?: number } = { type: "command", command };
    if (opts.timeout !== undefined) hook.timeout = opts.timeout;
    groups.push({ hooks: [hook] });
  }
  out.hooks[event] = groups;
  return out;
}

export function removeHookFromSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
): Record<string, any> {
  const out = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const groups: HookGroup[] = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
  const kept = groups
    .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => h.command !== command) }))
    .filter(g => g.hooks.length > 0);
  if (kept.length > 0) out.hooks[event] = kept;
  else delete out.hooks[event];
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

export async function installHook(
  projectDir: string,
  event: string,
  command: string,
  opts: { timeout?: number } = {},
): Promise<string> {
  const path = settingsPath(projectDir);
  assertInside(join(projectDir, ".claude"), path);
  let existing: Record<string, any> = {};
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`refusing to overwrite unreadable ${path}: ${(e as Error).message}`);
    }
    // ENOENT → no existing settings; start fresh
  }
  const merged = mergeHookIntoSettings(existing, event, command, opts);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(merged, null, 2));
  return path;
}

/** Remove a hook. Missing file → no-op; unreadable/corrupt → throw (never overwrite what we can't read). */
export async function removeHook(projectDir: string, event: string, command: string): Promise<string> {
  const path = settingsPath(projectDir);
  assertInside(join(projectDir, ".claude"), path);
  let existing: Record<string, any>;
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return path; // nothing to remove
    throw new Error(`refusing to overwrite unreadable ${path}: ${(e as Error).message}`);
  }
  const merged = removeHookFromSettings(existing, event, command);
  await writeFile(path, JSON.stringify(merged, null, 2));
  return path;
}

export async function hookInstalled(projectDir: string, event: string, command: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath(projectDir), "utf8"));
    const groups: HookGroup[] = Array.isArray(parsed?.hooks?.[event]) ? parsed.hooks[event] : [];
    return groups.some(g => g.hooks?.some(h => h.command === command));
  } catch {
    return false;
  }
}
