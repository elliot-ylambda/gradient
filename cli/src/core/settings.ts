import { join } from "node:path";
import { assertInside } from "./security.js";
import { safeReadFile, safeWriteFile } from "./safeFs.js";

const SETTINGS_MAX_BYTES = 1_000_000;

export function settingsPath(projectDir: string): string {
  return join(projectDir, ".claude", "settings.local.json");
}

interface HookGroup {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

function assertSettingsShape(value: unknown, event: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings root must be an object");
  }
  const hooks = (value as Record<string, unknown>).hooks;
  if (hooks === undefined) return;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new Error("settings hooks must be an object");
  }
  const groups = (hooks as Record<string, unknown>)[event];
  if (groups === undefined) return;
  if (!Array.isArray(groups) || groups.some(group => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return true;
    const entries = (group as Record<string, unknown>).hooks;
    return !Array.isArray(entries) || entries.some(hook =>
      !hook || typeof hook !== "object" || Array.isArray(hook) ||
      typeof (hook as Record<string, unknown>).command !== "string"
    );
  })) {
    throw new Error(`settings hooks.${event} has an invalid shape`);
  }
}

export function mergeHookIntoSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
  opts: { timeout?: number; matcher?: string; replacing?: string[] } = {},
): Record<string, any> {
  assertSettingsShape(existing, event);
  const out = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  let groups: HookGroup[] = (Array.isArray(out.hooks[event]) ? out.hooks[event] : [])
    .map((group: HookGroup) => ({ ...group, hooks: group.hooks.map(hook => ({ ...hook })) }));

  const replacing = new Set((opts.replacing ?? []).filter(candidate => candidate !== command));
  if (replacing.size > 0) {
    groups = groups
      .map(group => ({ ...group, hooks: group.hooks.filter(hook => !replacing.has(hook.command)) }))
      .filter(group => group.hooks.length > 0);
  }

  const exactGroup = groups.find(group =>
    group.matcher === opts.matcher && group.hooks.some(hook => hook.command === command));
  if (exactGroup) {
    exactGroup.hooks = exactGroup.hooks.map(hook =>
      hook.command === command && opts.timeout !== undefined
        ? { ...hook, timeout: opts.timeout }
        : hook);
    out.hooks[event] = groups;
    return out;
  }

  // Older gradient versions installed several hooks without matchers. When a
  // later release gives that same hook an explicit matcher, migrate the lone
  // legacy entry instead of leaving it active for every tool.
  let hook: HookGroup["hooks"][number] = { type: "command", command };
  if (opts.matcher !== undefined) {
    const legacyGroup = groups.find(group =>
      (group.matcher === undefined || group.hooks.length > 1) &&
      group.hooks.some(candidate => candidate.command === command));
    if (legacyGroup) {
      const existingHook = legacyGroup.hooks.find(candidate => candidate.command === command)!;
      hook = { ...existingHook };
      legacyGroup.hooks = legacyGroup.hooks.filter(candidate => candidate.command !== command);
      if (legacyGroup.hooks.length === 0) groups.splice(groups.indexOf(legacyGroup), 1);
    }
  }
  if (opts.timeout !== undefined) hook.timeout = opts.timeout;
  groups.push({
    ...(opts.matcher !== undefined ? { matcher: opts.matcher } : {}),
    hooks: [hook],
  });
  out.hooks[event] = groups;
  return out;
}

export function removeHookFromSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
  matcher?: string,
): Record<string, any> {
  assertSettingsShape(existing, event);
  const out = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const groups: HookGroup[] = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
  const kept = groups
    .map(group => matcher !== undefined && group.matcher !== matcher
      ? { ...group, hooks: [...group.hooks] }
      : { ...group, hooks: (group.hooks ?? []).filter(hook => hook.command !== command) })
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
  opts: { timeout?: number; matcher?: string; replacing?: string[] } = {},
): Promise<string> {
  const path = settingsPath(projectDir);
  assertInside(join(projectDir, ".claude"), path);
  let existing: Record<string, any> = {};
  try {
    existing = JSON.parse(await safeReadFile(projectDir, path, { maxBytes: SETTINGS_MAX_BYTES }));
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
export async function removeHook(
  projectDir: string,
  event: string,
  command: string,
  matcher?: string,
): Promise<string> {
  const path = settingsPath(projectDir);
  assertInside(join(projectDir, ".claude"), path);
  let existing: Record<string, any>;
  try {
    existing = JSON.parse(await safeReadFile(projectDir, path, { maxBytes: SETTINGS_MAX_BYTES }));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return path; // nothing to remove
    throw new Error(`refusing to overwrite unreadable ${path}: ${(e as Error).message}`);
  }
  const merged = removeHookFromSettings(existing, event, command, matcher);
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
    const parsed = JSON.parse(await safeReadFile(
      projectDir,
      settingsPath(projectDir),
      { maxBytes: SETTINGS_MAX_BYTES },
    ));
    const groups: HookGroup[] = Array.isArray(parsed?.hooks?.[event]) ? parsed.hooks[event] : [];
    return groups.some(group =>
      (opts.matcher === undefined || group.matcher === opts.matcher) &&
      group.hooks?.some(hook => hook.command === command),
    );
  } catch {
    return false;
  }
}
