import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalize, similarity } from "./cluster.js";
import { projectCacheDir } from "../config.js";
import { safeReadFile, safeWriteFile } from "./safeFs.js";
import { sanitizeName, stripUnsafeControls } from "./security.js";

export interface RecallEntry {
  name: string;
  kind: "skill" | "command";
  invocation: string;
  triggers: string[];
  signature: string;
  description: string;
}

export interface RecallIndex {
  builtAt: string;
  entries: RecallEntry[];
}

export const RECALL_THRESHOLD = 0.55;
export const NEAR_MISS_THRESHOLD = 0.4;

export function recallIndexPath(projectDir: string, home?: string): string {
  return join(projectCacheDir(projectDir, home), "recall.json");
}

export function extractTriggers(description: string): string[] {
  const clause = /use when the user says things like: (.+)$/i.exec(description.trim());
  if (!clause) return [];

  const triggers: string[] = [];
  const quoted = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(clause[1])) !== null) {
    let trigger = match[1];
    try {
      trigger = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      trigger = trigger.replace(/\\"/g, '"');
    }
    if (trigger && !triggers.includes(trigger)) triggers.push(trigger);
  }
  return triggers;
}

function splitFrontmatter(raw: string): { description: string; body: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!frontmatter) return { description: "", body: raw };

  const line = frontmatter[1]
    .split(/\r?\n/)
    .find(candidate => /^\s*description\s*:/.test(candidate));
  let description = line?.replace(/^\s*description\s*:\s*/, "") ?? "";
  if (description.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(description);
      if (typeof parsed === "string") description = parsed;
    } catch {
      // Preserve a malformed legacy scalar as plain text.
    }
  }
  return { description, body: raw.slice(frontmatter[0].length) };
}

async function entryFrom(
  path: string,
  name: string,
  kind: "skill" | "command",
  base: string,
): Promise<RecallEntry | null> {
  let raw: string;
  try {
    raw = await safeReadFile(base, path);
  } catch {
    return null;
  }

  const { description, body } = splitFrontmatter(raw);
  return {
    name,
    kind,
    invocation: `/${name}`,
    triggers: extractTriggers(description),
    signature: normalize(body).slice(0, 200),
    description: normalize(description),
  };
}

async function scanRoot(base: string, root: string, kind: "skill" | "command"): Promise<RecallEntry[]> {
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch {
    return [];
  }

  const entries: RecallEntry[] = [];
  for (const name of names) {
    const entry = kind === "skill"
      ? await entryFrom(join(root, name, "SKILL.md"), name, "skill", base)
      : name.endsWith(".md")
        ? await entryFrom(join(root, name), name.slice(0, -3), "command", base)
        : null;
    if (entry) entries.push(entry);
  }
  return entries;
}

function artifactRoots(
  projectDir: string,
  home?: string,
): Array<{ base: string; root: string; kind: "skill" | "command" }> {
  const userHome = home ?? homedir();
  return [
    { base: projectDir, root: join(projectDir, ".claude", "skills"), kind: "skill" },
    { base: projectDir, root: join(projectDir, ".claude", "commands"), kind: "command" },
    { base: userHome, root: join(userHome, ".claude", "skills"), kind: "skill" },
    { base: userHome, root: join(userHome, ".claude", "commands"), kind: "command" },
  ];
}

export async function buildRecallIndex(projectDir: string, home?: string): Promise<RecallIndex> {
  const entries: RecallEntry[] = [];
  for (const { base, root, kind } of artifactRoots(projectDir, home)) {
    entries.push(...(await scanRoot(base, root, kind)));
  }
  return { builtAt: new Date().toISOString(), entries: entries.filter(validEntry).slice(0, 1_000) };
}

export async function saveRecallIndex(projectDir: string, index: RecallIndex, home?: string): Promise<void> {
  const builtAt = Date.parse(index.builtAt);
  if (!Number.isFinite(builtAt) || builtAt > Date.now() + 5 * 60_000 ||
    index.entries.length > 1_000 || !index.entries.every(validEntry)) {
    throw new Error("refusing invalid recall index");
  }
  const userHome = home ?? homedir();
  await safeWriteFile(userHome, recallIndexPath(projectDir, userHome), JSON.stringify(index));
}

function validEntry(entry: unknown): entry is RecallEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<RecallEntry>;
  return (
    typeof candidate.name === "string" && candidate.name.length <= 40 &&
    sanitizeName(candidate.name) === candidate.name && stripUnsafeControls(candidate.name) === candidate.name &&
    (candidate.kind === "skill" || candidate.kind === "command") &&
    candidate.invocation === `/${candidate.name}` &&
    Array.isArray(candidate.triggers) &&
    candidate.triggers.length <= 20 &&
    candidate.triggers.every(trigger => typeof trigger === "string" && trigger.length <= 1_000 && stripUnsafeControls(trigger) === trigger) &&
    typeof candidate.signature === "string" && candidate.signature.length <= 200 && stripUnsafeControls(candidate.signature) === candidate.signature &&
    typeof candidate.description === "string" && candidate.description.length <= 2_000 && stripUnsafeControls(candidate.description) === candidate.description
  );
}

export async function loadRecallIndex(projectDir: string, home?: string): Promise<RecallIndex | null> {
  try {
    const userHome = home ?? homedir();
    const index = JSON.parse(await safeReadFile(userHome, recallIndexPath(projectDir, userHome))) as Partial<RecallIndex>;
    const builtAt = typeof index.builtAt === "string" ? Date.parse(index.builtAt) : Number.NaN;
    if (
      typeof index.builtAt !== "string" ||
      !Number.isFinite(builtAt) || builtAt > Date.now() + 5 * 60_000 ||
      !Array.isArray(index.entries) ||
      index.entries.length > 1_000 ||
      !index.entries.every(validEntry)
    ) {
      return null;
    }
    return index as RecallIndex;
  } catch {
    return null;
  }
}

export async function recallIndexFresh(
  index: RecallIndex,
  projectDir: string,
  home?: string,
): Promise<boolean> {
  const builtAt = Date.parse(index.builtAt);
  if (!Number.isFinite(builtAt) || builtAt > Date.now() + 5 * 60_000) return false;
  for (const { root, kind } of artifactRoots(projectDir, home)) {
    try {
      // ISO timestamps have millisecond precision while stat() can expose
      // fractional milliseconds. Compare at the shared precision so a root
      // created just before the index is not immediately considered stale.
      if (Math.floor((await stat(root)).mtimeMs) > builtAt) return false;
      const names = await readdir(root);
      for (const name of names) {
        const path = kind === "skill"
          ? join(root, name, "SKILL.md")
          : name.endsWith(".md")
            ? join(root, name)
            : null;
        if (!path) continue;
        try {
          if (Math.floor((await stat(path)).mtimeMs) > builtAt) return false;
        } catch {
          // A root mtime change catches removals; unreadable unrelated entries
          // do not make the hook fail closed.
        }
      }
    } catch {
      // Missing roots are valid and contribute no artifacts.
    }
  }
  return true;
}

export function matchPrompt(
  prompt: string,
  index: RecallIndex,
): { entry: RecallEntry; score: number } | null {
  const normalizedPrompt = normalize(prompt);
  let best: { entry: RecallEntry; score: number } | null = null;

  for (const entry of index.entries) {
    const targets = [...entry.triggers, entry.signature, entry.description]
      .map(normalize)
      .filter(target => target.length > 0);
    let score = 0;
    for (const target of targets) {
      score = Math.max(score, similarity(normalizedPrompt, target));
    }
    if (!best || score > best.score) best = { entry, score };
  }

  return best;
}
