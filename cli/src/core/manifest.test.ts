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

  /**
   * The cap on a hook command was 200, set when gradient installed
   * `gradient checkpoint`. gradient now installs `<node> <its own runner>
   * <subcommand>` — two absolute paths — and 200 rejected them, so turning on a
   * feature reported "invalid hook record" and silently applied nothing. The
   * cap is still a cap; it just has to fit two real paths.
   */
  it("accepts the two-absolute-path command gradient actually installs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    // The exact shape the dogfood harness produced when this first failed.
    const node = "/Users/a-fairly-long-account-name/.local/share/mise/installs/node/24.1.0/bin/node";
    const runner = "/var/folders/8k/9v0m4c1n7wl0qk3z9f2r5xh0000gn/T/gradient-dogfood-a1b2c3" +
      "/gradient-home/.agents/skills/gradient-optimize/bin/gradient.mjs";
    const command = `${node} ${runner} session-start`;
    expect(command.length).toBeGreaterThan(200);

    await addEntry(dir, {
      name: "optimize-session", type: "hook", path: "", createdAt: "2026-08-16",
      suggestionId: "optimize-session", hook: { event: "SessionStart", command },
    });
    expect((await loadManifest(dir))[0]?.hook?.command).toBe(command);
  });

  it("still refuses a hook command longer than any pair of real paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await expect(addEntry(dir, {
      name: "huge", type: "hook", path: "", createdAt: "2026-08-16",
      suggestionId: "huge", hook: { event: "SessionStart", command: `x${"y".repeat(2_200)}` },
    })).rejects.toThrow(/invalid hook record/);
  });
});
