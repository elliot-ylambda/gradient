import { lstat, opendir, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter, scalar } from "./frontmatter.js";

/**
 * The topic notes in a Claude Code auto-memory directory, as evidence.
 *
 * Claude Code loads only MEMORY.md (its first 200 lines or 25 KB) at session
 * start and reads topic files on demand when the index points at them. A note
 * the index does not link is, in practice, never read; on a real repository
 * worked by ~40 parallel sessions that was 683 of 832 notes — including most
 * of the user's own corrections — and most of what had been saved was PR and
 * deploy status that git already records.
 *
 * Read-only: evidence for the user and their assistant, never an edit. An
 * "archive notes about merged PRs" rule was tried against that repository and
 * dropped — the sampled notes all carried real lessons beside the PR status.
 */

const MAX_NOTES = 5_000;
const HEAD_BYTES = 8_192;
/** A note this large is a log someone kept, not something to remember. */
export const MEMORY_NOTE_LOG_BYTES = 25_000;

export const NOTE_TYPES = ["feedback", "project", "reference", "user", "other"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export interface MemoryNote {
  name: string;
  bytes: number;
  mtimeMs: number;
  type: NoteType;
  description: string;
  /** Whether MEMORY.md links to it, so a session can find it. */
  linked: boolean;
}

export interface MemoryNotes {
  dir: string;
  notes: MemoryNote[];
}

const TYPE_PREFIX = /^(feedback|project|reference|user)[_-]/;

function noteType(name: string, head: string): NoteType {
  const prefix = TYPE_PREFIX.exec(name)?.[1];
  if (prefix) return prefix as NoteType;
  const declared = /^\s*type:\s*(feedback|project|reference|user)\b/m.exec(head)?.[1];
  return (declared as NoteType | undefined) ?? "other";
}

async function readHead(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Notes MEMORY.md links to, by file name. */
export function linkedNames(index: string): Set<string> {
  return new Set([...index.matchAll(/\]\(([^)\s]+\.md)\)/g)].map(match => basename(match[1])));
}

export async function loadMemoryNotes(indexPath: string, index: string): Promise<MemoryNotes | null> {
  const dir = dirname(indexPath);
  const entries = await opendir(dir).catch(() => null);
  if (!entries) return null;
  const linked = linkedNames(index);
  const notes: MemoryNote[] = [];
  for await (const entry of entries) {
    if (notes.length >= MAX_NOTES) break;
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "MEMORY.md") continue;
    const path = join(dir, entry.name);
    try {
      const stats = await lstat(path);
      if (!stats.isFile()) continue;
      const head = await readHead(path);
      const frontmatter = parseFrontmatter(head);
      notes.push({
        name: entry.name,
        bytes: stats.size,
        mtimeMs: stats.mtimeMs,
        type: noteType(entry.name, head),
        description: (scalar(frontmatter, "description") ?? "").slice(0, 500),
        linked: linked.has(entry.name),
      });
    } catch {
      // Unreadable note: nothing to say about it.
    }
  }
  notes.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, notes };
}
