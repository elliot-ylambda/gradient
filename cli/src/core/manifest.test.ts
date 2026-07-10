import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, addEntry, removeEntries } from "./manifest.js";
import type { ManifestEntry } from "./types.js";

const entry = (name: string, target?: "claude-code" | "codex"): ManifestEntry => ({
  name,
  type: "skill",
  path: target === "codex" ? `.agents/skills/${name}/SKILL.md` : `.claude/skills/${name}/SKILL.md`,
  createdAt: "2026-06-29",
  suggestionId: name,
  ...(target ? { target } : {}),
});

describe("manifest", () => {
  it("adds, lists, replaces, and removes entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    expect(await loadManifest(dir)).toEqual([]);
    await addEntry(dir, entry("ship"));
    await addEntry(dir, entry("ship")); // replace, not duplicate
    expect((await loadManifest(dir)).length).toBe(1);
    const removed = await removeEntries(dir, "ship");
    expect(removed[0]?.name).toBe("ship");
    expect(await loadManifest(dir)).toEqual([]);
  });

  it("keys entries by name and target, treating an absent target as claude-code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await addEntry(dir, entry("ship"));
    await addEntry(dir, entry("ship", "codex"));
    await addEntry(dir, { ...entry("ship"), target: "claude-code" });
    expect(await loadManifest(dir)).toHaveLength(2);
  });

  it("removes every target for a name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await addEntry(dir, entry("ship"));
    await addEntry(dir, entry("ship", "codex"));
    expect(await removeEntries(dir, "ship")).toHaveLength(2);
    expect(await removeEntries(dir, "ghost")).toEqual([]);
  });
});
