import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeAppendFile, safeWriteFile } from "./safeFs.js";

describe("safe filesystem boundaries", () => {
  it("rejects a symlinked ancestor and preserves the external victim", async () => {
    const root = await mkdtemp(join(tmpdir(), "gradient-safe-root-"));
    const outside = await mkdtemp(join(tmpdir(), "gradient-safe-out-"));
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "keep");
    await symlink(outside, join(root, ".gradient"));
    await expect(safeWriteFile(root, join(root, ".gradient", "victim.txt"), "replace")).rejects.toThrow(/symlink/);
    expect(await readFile(victim, "utf8")).toBe("keep");
  });

  it("rejects final write and append symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "gradient-safe-final-"));
    const outside = await mkdtemp(join(tmpdir(), "gradient-safe-victim-"));
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "keep");
    await mkdir(join(root, ".gradient"));
    const link = join(root, ".gradient", "cache.json");
    await symlink(victim, link);
    await expect(safeWriteFile(root, link, "replace")).rejects.toThrow(/symlink/);
    await expect(safeAppendFile(root, link, "append")).rejects.toThrow(/symlink/);
    expect(await readFile(victim, "utf8")).toBe("keep");
  });
});
