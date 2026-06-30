import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
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
});
