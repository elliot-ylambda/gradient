import { randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  constants,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function resolvedInside(base: string, target: string): { base: string; target: string } {
  const b = resolve(base);
  const t = resolve(target);
  const rel = relative(b, t);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`refusing path outside ${b}: ${t}`);
  }
  return { base: b, target: t };
}

function descendants(base: string, target: string, includeTarget = true): string[] {
  const paths: string[] = [];
  const rel = relative(base, target);
  let cursor = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    paths.push(cursor);
  }
  return includeTarget ? paths : paths.slice(0, -1);
}

/** Reject every existing symlink beneath the trusted base. This closes the
 * gap left by lexical containment checks when a repository commits .claude or
 * .gradient as a symlink. */
export async function assertNoSymlinkPath(
  base: string,
  target: string,
  opts: { includeTarget?: boolean } = {},
): Promise<void> {
  const resolved = resolvedInside(base, target);
  for (const path of descendants(resolved.base, resolved.target, opts.includeTarget ?? true)) {
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(`refusing symlinked path: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function assertNoSymlinkPathSync(
  base: string,
  target: string,
  opts: { includeTarget?: boolean } = {},
): void {
  const resolved = resolvedInside(base, target);
  for (const path of descendants(resolved.base, resolved.target, opts.includeTarget ?? true)) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing symlinked path: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function safeMkdir(base: string, path: string, mode = 0o700): Promise<void> {
  await assertNoSymlinkPath(base, path);
  await mkdir(path, { recursive: true, mode });
  await assertNoSymlinkPath(base, path);
}

export async function safeReadFile(
  base: string,
  path: string,
  opts: { maxBytes?: number } = {},
): Promise<string> {
  const resolved = resolvedInside(base, path);
  await assertNoSymlinkPath(resolved.base, resolved.target);
  const handle = await open(
    resolved.target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw Object.assign(new Error(`refusing non-file path: ${resolved.target}`), { code: "EISDIR" });
    }
    if (opts.maxBytes !== undefined && metadata.size > opts.maxBytes) {
      throw Object.assign(new Error(`file exceeds ${opts.maxBytes} byte cap: ${resolved.target}`), { code: "EFBIG" });
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function safeWriteFile(
  base: string,
  path: string,
  data: string,
  opts: { exclusive?: boolean; mode?: number; dirMode?: number } = {},
): Promise<void> {
  const resolved = resolvedInside(base, path);
  await safeMkdir(resolved.base, dirname(resolved.target), opts.dirMode ?? 0o700);
  await assertNoSymlinkPath(resolved.base, resolved.target);
  const mode = opts.mode ?? 0o600;
  if (opts.exclusive) {
    await writeFile(resolved.target, data, { flag: "wx", mode });
    return;
  }

  // Atomic replacement never follows a final symlink that appears after the
  // check: rename replaces the directory entry itself.
  const temp = join(dirname(resolved.target), `.gradient-tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temp, data, { flag: "wx", mode });
    await rename(temp, resolved.target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function safeAppendFile(
  base: string,
  path: string,
  data: string,
  mode = 0o600,
): Promise<void> {
  const resolved = resolvedInside(base, path);
  await safeMkdir(resolved.base, dirname(resolved.target));
  await assertNoSymlinkPath(resolved.base, resolved.target);
  // appendFile with numeric O_NOFOLLOW flags rejects a final symlink.
  await appendFile(
    resolved.target,
    data,
    { flag: constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), mode },
  );
}

export async function safeUnlink(base: string, path: string): Promise<void> {
  // A final symlink is safe to unlink; no ancestor may redirect the operation.
  await assertNoSymlinkPath(base, path, { includeTarget: false });
  await unlink(path);
}

export function safeOpenAppendSync(base: string, path: string, mode = 0o600): number {
  const resolved = resolvedInside(base, path);
  assertNoSymlinkPathSync(resolved.base, dirname(resolved.target));
  mkdirSync(dirname(resolved.target), { recursive: true, mode: 0o700 });
  assertNoSymlinkPathSync(resolved.base, resolved.target);
  return openSync(
    resolved.target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    mode,
  );
}
