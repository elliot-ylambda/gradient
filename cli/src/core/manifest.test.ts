import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, addEntry, removeEntry } from "./manifest.js";
import type { ManifestEntry } from "./types.js";

const entry = (name: string): ManifestEntry =>
  ({ name, type: "command", path: `.claude/commands/${name}.md`, createdAt: "2026-06-29", suggestionId: name });

describe("manifest", () => {
  it("adds, lists, replaces, and removes entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    expect(await loadManifest(dir)).toEqual([]);
    await addEntry(dir, entry("ship"));
    await addEntry(dir, entry("ship")); // replace, not duplicate
    expect((await loadManifest(dir)).length).toBe(1);
    const removed = await removeEntry(dir, "ship");
    expect(removed?.name).toBe("ship");
    expect(await loadManifest(dir)).toEqual([]);
  });

  it("rejects paths that do not exactly match the generated type and name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify([{
      ...entry("ship"), path: join(dir, ".claude", "settings.local.json"),
    }]));
    await expect(loadManifest(dir)).rejects.toThrow(/path/);
  });

  it("rejects unsafe names and non-array manifests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify([{
      ...entry("ship"), name: "../ship",
    }]));
    await expect(loadManifest(dir)).rejects.toThrow(/name/);
    await writeFile(join(dir, ".gradient", "manifest.json"), "{}");
    await expect(loadManifest(dir)).rejects.toThrow(/bounded array/);
  });
});
