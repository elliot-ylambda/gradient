import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalize, similarity } from "./cluster.js";
import { gradientDir } from "./manifest.js";

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

export function recallIndexPath(projectDir: string): string {
  return join(gradientDir(projectDir), "recall.json");
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
): Promise<RecallEntry | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
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

async function scanRoot(root: string, kind: "skill" | "command"): Promise<RecallEntry[]> {
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch {
    return [];
  }

  const entries: RecallEntry[] = [];
  for (const name of names) {
    const entry = kind === "skill"
      ? await entryFrom(join(root, name, "SKILL.md"), name, "skill")
      : name.endsWith(".md")
        ? await entryFrom(join(root, name), name.slice(0, -3), "command")
        : null;
    if (entry) entries.push(entry);
  }
  return entries;
}

function artifactRoots(
  projectDir: string,
  home?: string,
): Array<{ root: string; kind: "skill" | "command" }> {
  const userHome = home ?? homedir();
  return [
    { root: join(projectDir, ".claude", "skills"), kind: "skill" },
    { root: join(projectDir, ".claude", "commands"), kind: "command" },
    { root: join(userHome, ".claude", "skills"), kind: "skill" },
    { root: join(userHome, ".claude", "commands"), kind: "command" },
  ];
}

export async function buildRecallIndex(projectDir: string, home?: string): Promise<RecallIndex> {
  const entries: RecallEntry[] = [];
  for (const { root, kind } of artifactRoots(projectDir, home)) {
    entries.push(...(await scanRoot(root, kind)));
  }
  return { builtAt: new Date().toISOString(), entries };
}

export async function saveRecallIndex(projectDir: string, index: RecallIndex): Promise<void> {
  const path = recallIndexPath(projectDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(index));
}

function validEntry(entry: unknown): entry is RecallEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<RecallEntry>;
  return (
    typeof candidate.name === "string" &&
    (candidate.kind === "skill" || candidate.kind === "command") &&
    typeof candidate.invocation === "string" &&
    Array.isArray(candidate.triggers) &&
    candidate.triggers.every(trigger => typeof trigger === "string") &&
    typeof candidate.signature === "string" &&
    typeof candidate.description === "string"
  );
}

export async function loadRecallIndex(projectDir: string): Promise<RecallIndex | null> {
  try {
    const index = JSON.parse(await readFile(recallIndexPath(projectDir), "utf8")) as Partial<RecallIndex>;
    if (
      typeof index.builtAt !== "string" ||
      !Number.isFinite(Date.parse(index.builtAt)) ||
      !Array.isArray(index.entries) ||
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
  if (!Number.isFinite(builtAt)) return false;
  for (const { root } of artifactRoots(projectDir, home)) {
    try {
      // ISO timestamps have millisecond precision while stat() can expose
      // fractional milliseconds. Compare at the shared precision so a root
      // created just before the index is not immediately considered stale.
      if (Math.floor((await stat(root)).mtimeMs) > builtAt) return false;
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
