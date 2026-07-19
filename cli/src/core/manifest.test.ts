import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, addEntry, removeEntries, expectedArtifactPath } from "./manifest.js";
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

describe("playbook-entry manifest entries", () => {
  const tmpProject = () => mkdtemp(join(tmpdir(), "grad-manifest-"));

  it("accepts a playbook-entry pointing at the repo gradient.md", async () => {
    const dir = await tmpProject();
    await addEntry(dir, {
      name: "pb-build-after-tests", type: "playbook-entry", path: join(dir, "gradient.md"),
      createdAt: "2026-07-18", suggestionId: "abc123",
    });
    const entries = await loadManifest(dir);
    expect(entries[0].type).toBe("playbook-entry");
    expect(expectedArtifactPath(dir, entries[0])).toBe(join(dir, "gradient.md"));
  });

  it("rejects a playbook-entry with any other path", async () => {
    const dir = await tmpProject();
    await expect(addEntry(dir, {
      name: "pb-x", type: "playbook-entry", path: join(dir, ".claude", "rules", "x.md"),
      createdAt: "2026-07-18", suggestionId: "abc124",
    })).rejects.toThrow(/path does not match/);
  });

  it("rejects a codex-target playbook-entry", async () => {
    const dir = await tmpProject();
    await expect(addEntry(dir, {
      name: "pb-y", type: "playbook-entry", path: join(dir, "gradient.md"),
      createdAt: "2026-07-18", suggestionId: "abc125", target: "codex",
    })).rejects.toThrow(/codex/);
  });
});
