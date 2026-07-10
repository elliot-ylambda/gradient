import { join } from "node:path";
import { assertInside } from "./security.js";
import { safeReadFile, safeWriteFile } from "./safeFs.js";

export function settingsPath(projectDir: string): string {
  return join(projectDir, ".claude", "settings.local.json");
}

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

export function mergeHookIntoSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
  opts: { timeout?: number; matcher?: string } = {},
): Record<string, any> {
  const out = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const existingGroups: HookGroup[] = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
  const groups: HookGroup[] = [];
  let matchedGroup: HookGroup | undefined;
  let matchedHook: HookGroup["hooks"][number] | undefined;

  for (const group of existingGroups) {
    const hooks = group.hooks ?? [];
    const match = hooks.find(hook => hook.command === command);
    if (match && !matchedHook) {
      matchedGroup = group;
      matchedHook = match;
    }
    const remaining = hooks.filter(hook => hook.command !== command);
    if (remaining.length > 0) groups.push({ ...group, hooks: remaining });
  }

  const hook: HookGroup["hooks"][number] = matchedHook
    ? { ...matchedHook }
    : { type: "command", command };
  if (opts.timeout !== undefined) hook.timeout = opts.timeout;
  const group: HookGroup = { ...(matchedGroup ?? {}), hooks: [hook] };
  if (opts.matcher !== undefined) group.matcher = opts.matcher;
  groups.push(group);
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
  opts: { timeout?: number; matcher?: string } = {},
): Promise<string> {
  const path = settingsPath(projectDir);
  assertInside(join(projectDir, ".claude"), path);
  let existing: Record<string, any> = {};
  try {
    existing = JSON.parse(await safeReadFile(projectDir, path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`refusing to overwrite unreadable ${path}: ${(e as Error).message}`);
    }
    // ENOENT → no existing settings; start fresh
  }
  const merged = mergeHookIntoSettings(existing, event, command, opts);
  await safeWriteFile(projectDir, path, JSON.stringify(merged, null, 2));
  return path;
}

/** Remove a hook. Missing file → no-op; unreadable/corrupt → throw (never overwrite what we can't read). */
export async function removeHook(projectDir: string, event: string, command: string): Promise<string> {
  const path = settingsPath(projectDir);
  assertInside(join(projectDir, ".claude"), path);
  let existing: Record<string, any>;
  try {
    existing = JSON.parse(await safeReadFile(projectDir, path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return path; // nothing to remove
    throw new Error(`refusing to overwrite unreadable ${path}: ${(e as Error).message}`);
  }
  const merged = removeHookFromSettings(existing, event, command);
  await safeWriteFile(projectDir, path, JSON.stringify(merged, null, 2));
  return path;
}

export async function hookInstalled(
  projectDir: string,
  event: string,
  command: string,
  opts: { matcher?: string } = {},
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await safeReadFile(projectDir, settingsPath(projectDir)));
    const groups: HookGroup[] = Array.isArray(parsed?.hooks?.[event]) ? parsed.hooks[event] : [];
    return groups.some(group =>
      (opts.matcher === undefined || group.matcher === opts.matcher) &&
      group.hooks?.some(hook => hook.command === command),
    );
  } catch {
    return false;
  }
}
