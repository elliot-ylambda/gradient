import { sep } from "node:path";
import type { Change } from "./findings.js";
import { type Run, sha256, snapshot } from "./run.js";
import { safeReadFile, safeUnlink, safeWriteFile } from "./safeFs.js";
import { assertInside, redact } from "./security.js";

/**
 * Execute one `Change` against a file gradient does not own.
 *
 * Everything here is written to survive being wrong. A change carries the exact
 * bytes it expected to find; if the file has moved on, the change is refused
 * rather than forced. Every write is preceded by a snapshot, so `--undo`
 * restores what was there. And no path is ever taken from a finding without
 * being re-derived and contained first.
 */

const MAX_FILE_BYTES = 512_000;

/** Leading indentation plus a markdown list marker, if any. */
const LIST_MARKER = /^(\s*(?:[-*+]|\d+[.)])\s+)?/;

/** A line as the instruction reader sees it: marker and surrounding space gone. */
function withoutMarker(line: string): string {
  return line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "").trim();
}

/** Text that must never enter an instruction file, in the order it is checked. */
const INJECTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /https?:\/\/|\bwww\./i, reason: "contains a URL" },
  { pattern: /```|^ {4,}\S/m, reason: "contains a code block" },
  { pattern: /\b(?:curl|wget|ssh|scp|sudo|eval|chmod|base64|nc|telnet)\b/i, reason: "names a shell or network command" },
  { pattern: /\|\s*(?:sh|bash|zsh)\b|>\s*\/dev\//i, reason: "pipes to a shell or redirects to a device" },
  { pattern: /\b(?:token|secret|password|passwd|credential)s?\b|\bapi[_-]?key\b/i, reason: "mentions a credential" },
  { pattern: /\b(?:ignore|disregard|override)\b.{0,40}\b(?:previous|prior|above|earlier)\b/i, reason: "reads as an instruction override" },
];

/** A command invocation, which `--auto` refuses in every family. */
const COMMAND_BEARING = /`[^`]+`|\b(?:run|execute|deploy|publish|push|install)\s+\S/i;

export const MAX_INSTRUCTION_CHARS = 200;

export interface Screen {
  ok: boolean;
  reason?: string;
  commandBearing: boolean;
}

/**
 * Whether text mined from transcripts may be written into an instruction file.
 *
 * This is the load-bearing guard of the whole feature. Until now gradient
 * *printed* a rule and a human retyped it; writing one means transcript-derived
 * text becomes instructions an agent obeys. A hostile repository, a pasted log,
 * or a poisoned dependency's output could otherwise land a command in the
 * user's CLAUDE.md and have it run in every future session.
 *
 * So the bar is deliberately blunt: instructions are short, plain prose. If the
 * proposed line reads like anything else, it does not go in a file.
 */
export function screenInstruction(text: string): Screen {
  const commandBearing = COMMAND_BEARING.test(text);
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "is empty", commandBearing };
  if (trimmed.length > MAX_INSTRUCTION_CHARS) {
    return { ok: false, reason: `is longer than ${MAX_INSTRUCTION_CHARS} characters`, commandBearing };
  }
  if (redact(trimmed) !== trimmed) {
    return { ok: false, reason: "contains something that redacts as a secret", commandBearing };
  }
  for (const { pattern, reason } of INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) return { ok: false, reason, commandBearing };
  }
  return { ok: true, commandBearing };
}

export interface ChangeContext {
  run: Run;
  projectDir: string;
  /** Trusted root for this change's path; the project for project-scope files. */
  base: string;
}

export interface ChangeOutcome {
  path: string;
  /** sha256 of the file as this change left it; recorded for undo. */
  sha256: string;
}

function assertContained(context: ChangeContext, path: string): void {
  assertInside(context.base, path);
}

async function read(context: ChangeContext, path: string): Promise<string | null> {
  try {
    return await safeReadFile(context.base, path, { maxBytes: MAX_FILE_BYTES });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function write(context: ChangeContext, path: string, content: string): Promise<ChangeOutcome> {
  await snapshot(context.run, path, context.base);
  await safeWriteFile(context.base, path, content, { mode: 0o644 });
  return { path, sha256: sha256(content) };
}

/**
 * Every op carries its own precondition, and each is the exact thing that op
 * could get wrong:
 *
 * - a line edit must find the exact text it was proposed for, at that line;
 * - `prepend-import` is idempotent — the import is either absent or already there;
 * - `create` refuses to overwrite;
 * - `delete-file` refuses a file gradient did not generate.
 *
 * That is what makes concurrent sessions safe, and `board` finds five live
 * sessions in this repository as a matter of course. There used to be a
 * whole-file hash here as well, but nothing ever populated it, so it asserted
 * nothing while reading as the guarantee — worse than no check, because it
 * described one. The per-op preconditions above are the real ones; findings are
 * recomputed from the current files on every run, and the writes happen under
 * the advisory lock.
 */
export async function applyChange(context: ChangeContext, change: Change): Promise<ChangeOutcome> {
  assertContained(context, change.path);
  const current = await read(context, change.path);

  switch (change.op) {
    case "prepend-import": {
      const line = (change.after ?? "").trim();
      if (!/^@[A-Za-z0-9._/-]+$/.test(line)) throw new Error(`refusing to prepend a non-import line: ${line}`);
      if (current !== null && current.includes(line)) return { path: change.path, sha256: sha256(current) };
      return write(context, change.path, current === null ? `${line}\n` : `${line}\n\n${current}`);
    }

    case "delete-line":
    case "replace-line": {
      if (current === null) throw new Error(`${change.path} no longer exists`);
      const lines = current.split("\n");
      const index = (change.line ?? 0) - 1;
      if (index < 0 || index >= lines.length) throw new Error(`${change.path} has no line ${change.line}`);
      // The line itself is the precondition: a whole-file hash can match while
      // an edit elsewhere has shifted this line's meaning, and the exact text
      // is what the user approved.
      //
      // Compared with the list marker stripped from both sides. The instruction
      // reader strips it when extracting a line, so a finding's `before` is
      // "Build it with x" while the file still says "- Build it with x" — a raw
      // comparison refused every bulleted line, which is nearly all of them,
      // and did it silently.
      if (change.before !== undefined && withoutMarker(lines[index]) !== withoutMarker(change.before)) {
        throw new Error(`${change.path}:${change.line} is not the line this was proposed for`);
      }
      if (change.op === "delete-line") lines.splice(index, 1);
      else {
        const after = change.after ?? "";
        const screen = screenInstruction(after);
        if (!screen.ok) throw new Error(`refusing to write an instruction that ${screen.reason}`);
        // Keep the original bullet marker and indentation.
        const prefix = LIST_MARKER.exec(lines[index])?.[0] ?? "";
        lines[index] = `${prefix}${after.trim()}`;
      }
      return write(context, change.path, lines.join("\n"));
    }

    case "create": {
      const content = change.after ?? "";
      if (current !== null) throw new Error(`refusing to overwrite an existing file: ${change.path}`);
      return write(context, change.path, content);
    }

    case "delete-file": {
      if (current === null) return { path: change.path, sha256: sha256("") };
      // Only ever a file gradient generated. Without this an id collision, or a
      // manifest a repository committed, could point removal at anything.
      if (!current.slice(0, 2_000).includes("<!-- gradient:")) {
        throw new Error(`refusing to delete a file gradient did not generate: ${change.path}`);
      }
      await snapshot(context.run, change.path, context.base);
      await safeUnlink(context.base, change.path);
      return { path: change.path, sha256: sha256("") };
    }

    case "splice-line":
      // Tagged-line insertion into a shared file goes through applySuggestion,
      // which owns the manifest entry that makes the line removable.
      throw new Error("splice-line changes are applied through applySuggestion");
  }
}

/** Whether `--auto` may apply this change without a human looking at it. */
export function autoApplicable(change: Change): { ok: boolean; reason?: string } {
  if (change.op === "replace-line" || change.op === "delete-line") {
    return { ok: false, reason: "edits prose a person wrote" };
  }
  if (change.op === "delete-file") return { ok: true };
  if (change.op === "prepend-import" || change.op === "create") return { ok: true };
  return { ok: false, reason: `op ${change.op} is not applied unattended` };
}

/** Re-derive a change's trusted root. A finding names a path; only this decides
 *  which tree it is allowed to be in. */
export function baseFor(change: Change, projectDir: string, home: string): string {
  // `join(home, "/")` normalizes back to `home`, which would match any path
  // sharing a prefix with the home directory name. Compare against the
  // separator explicitly.
  return change.path.startsWith(`${home}${sep}`) ? home : projectDir;
}
