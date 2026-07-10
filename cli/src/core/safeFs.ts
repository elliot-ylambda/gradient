import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  constants,
  fchmodSync,
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
    if (opts.maxBytes === undefined) return await handle.readFile("utf8");

    // Do not trust the pre-read stat alone: an append or file replacement race
    // could otherwise grow the file between stat() and readFile(). Read at most
    // maxBytes + 1 through the already-open O_NOFOLLOW descriptor and reject
    // overflow without allocating or ingesting the rest.
    if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0) {
      throw new Error("maxBytes must be a non-negative safe integer");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= opts.maxBytes) {
      const capacity = Math.min(64 * 1024, opts.maxBytes + 1 - total);
      const buffer = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(buffer, 0, capacity, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > opts.maxBytes) {
      throw Object.assign(new Error(`file exceeds ${opts.maxBytes} byte cap: ${resolved.target}`), { code: "EFBIG" });
    }
    return Buffer.concat(chunks, total).toString("utf8");
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
  opts: number | { mode?: number; maxBytes?: number } = {},
): Promise<void> {
  const resolved = resolvedInside(base, path);
  await safeMkdir(resolved.base, dirname(resolved.target));
  await assertNoSymlinkPath(resolved.base, resolved.target);
  const mode = typeof opts === "number" ? opts : (opts.mode ?? 0o600);
  const maxBytes = typeof opts === "number" ? undefined : opts.maxBytes;
  // Opening the descriptor ourselves lets us enforce both O_NOFOLLOW and a
  // bounded append log without a second path-based race.
  const handle = await open(
    resolved.target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    await handle.chmod(mode);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`refusing non-file append path: ${resolved.target}`);
    const appendBytes = Buffer.byteLength(data, "utf8");
    if (maxBytes !== undefined && metadata.size + appendBytes > maxBytes) {
      throw Object.assign(new Error(`append would exceed ${maxBytes} byte cap: ${resolved.target}`), { code: "EFBIG" });
    }
    await handle.writeFile(data, "utf8");
  } finally {
    await handle.close();
  }
}

export async function safeUnlink(base: string, path: string): Promise<void> {
  // A final symlink is safe to unlink; no ancestor may redirect the operation.
  await assertNoSymlinkPath(base, path, { includeTarget: false });
  await unlink(path);
}

/** Remove a generated subtree without following a symlinked ancestor or final
 * target. Symlinks contained inside a real directory are unlinked by rm rather
 * than traversed. */
export async function safeRemoveTree(base: string, path: string): Promise<void> {
  const resolved = resolvedInside(base, path);
  await assertNoSymlinkPath(resolved.base, resolved.target, { includeTarget: false });
  try {
    const target = await lstat(resolved.target);
    if (target.isSymbolicLink()) {
      await unlink(resolved.target);
      return;
    }
    await rm(resolved.target, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Rename a real file or directory within one trusted tree. Both ancestor
 * chains and final entries are checked immediately before the atomic rename;
 * callers should use unique, absent destination names. */
export async function safeRename(base: string, from: string, to: string): Promise<void> {
  const source = resolvedInside(base, from);
  const destination = resolvedInside(base, to);
  await assertNoSymlinkPath(source.base, source.target);
  await assertNoSymlinkPath(destination.base, destination.target);
  await rename(source.target, destination.target);
  await assertNoSymlinkPath(destination.base, destination.target);
}

export function safeOpenAppendSync(base: string, path: string, mode = 0o600): number {
  const resolved = resolvedInside(base, path);
  assertNoSymlinkPathSync(resolved.base, dirname(resolved.target));
  mkdirSync(dirname(resolved.target), { recursive: true, mode: 0o700 });
  assertNoSymlinkPathSync(resolved.base, resolved.target);
  const fd = openSync(
    resolved.target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  fchmodSync(fd, mode);
  return fd;
}

/** Open a private bounded-by-replacement log target without following links.
 * Callers that write a fresh diagnostic log per run avoid unbounded append
 * growth across repeated hook invocations. */
export function safeOpenWriteSync(base: string, path: string, mode = 0o600): number {
  const resolved = resolvedInside(base, path);
  assertNoSymlinkPathSync(resolved.base, dirname(resolved.target));
  mkdirSync(dirname(resolved.target), { recursive: true, mode: 0o700 });
  assertNoSymlinkPathSync(resolved.base, resolved.target);
  const fd = openSync(
    resolved.target,
    constants.O_WRONLY | constants.O_TRUNC | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  fchmodSync(fd, mode);
  return fd;
}
