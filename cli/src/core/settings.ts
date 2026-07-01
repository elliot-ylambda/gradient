import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { assertInside } from "./security.js";

export function settingsPath(projectDir: string): string {
  return join(projectDir, ".claude", "settings.json");
}

interface HookGroup { hooks: { type: string; command: string }[] }

export function mergeHookIntoSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
): Record<string, any> {
  const out = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const groups: HookGroup[] = Array.isArray(out.hooks[event]) ? [...out.hooks[event]] : [];
  const already = groups.some(g => g.hooks?.some(h => h.command === command));
  if (!already) groups.push({ hooks: [{ type: "command", command }] });
  out.hooks[event] = groups;
  return out;
}

export async function installHook(projectDir: string, event: string, command: string): Promise<string> {
  const path = settingsPath(projectDir);
  assertInside(join(projectDir, ".claude"), path);
  let existing: Record<string, any> = {};
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch {
    existing = {};
  }
  const merged = mergeHookIntoSettings(existing, event, command);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(merged, null, 2));
  return path;
}
