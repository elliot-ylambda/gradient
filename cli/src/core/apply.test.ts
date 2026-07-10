import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySuggestion } from "./apply.js";
import { addEntry, loadManifest } from "./manifest.js";
import type { Suggestion } from "./types.js";

const base = { id: "x", title: "t", rationale: "r", evidence: { count: 3, sessions: 2 }, confidence: "high" as const };

describe("applySuggestion", () => {
  it("writes a SKILL.md by default and records manifest type skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const s: Suggestion = {
      ...base,
      name: "lgtm",
      payload: { type: "command", commandName: "lgtm", body: "approve it", triggers: ["lgtm"] },
    };
    const r = await applySuggestion(s, dir);
    expect(r.written).toBe(join(dir, ".claude/skills/lgtm/SKILL.md"));
    expect(await readFile(r.written!, "utf8")).toContain("approve it");
    expect((await loadManifest(dir))[0]).toMatchObject({ name: "lgtm", type: "skill" });
  });

  it("writes a command file and records it in the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const s: Suggestion = { ...base, name: "ship", payload: { type: "command", commandName: "ship", body: "do it" } };
    const r = await applySuggestion(s, dir, { emitTarget: "command" });
    expect(r.written).toBe(join(dir, ".claude/commands/ship.md"));
    expect(await readFile(r.written!, "utf8")).toContain("do it");
    expect((await loadManifest(dir))[0]).toMatchObject({ name: "ship", type: "command" });
  });

  it("refuses to overwrite an untracked hand-written skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const path = join(dir, ".claude", "skills", "ship", "SKILL.md");
    await mkdir(join(dir, ".claude", "skills", "ship"), { recursive: true });
    await writeFile(path, "hand-written skill\n");
    const s: Suggestion = {
      ...base,
      name: "ship",
      payload: { type: "command", commandName: "ship", body: "generated body" },
    };

    await expect(applySuggestion(s, dir)).rejects.toThrow(/untracked artifact/);
    expect(await readFile(path, "utf8")).toBe("hand-written skill\n");
    expect(await loadManifest(dir)).toEqual([]);
  });

  it("can update a skill already tracked under the same manifest name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const first: Suggestion = {
      ...base,
      name: "ship",
      payload: { type: "command", commandName: "ship", body: "first body" },
    };
    await applySuggestion(first, dir);
    await applySuggestion({ ...first, payload: { ...first.payload, body: "updated body" } }, dir);
    expect(await readFile(join(dir, ".claude", "skills", "ship", "SKILL.md"), "utf8")).toContain("updated body");
  });

  it("refuses a tracked artifact symlink without touching its victim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const outside = await mkdtemp(join(tmpdir(), "grad-victim-"));
    const victim = join(outside, "victim.txt");
    const path = join(dir, ".claude", "skills", "ship", "SKILL.md");
    await writeFile(victim, "keep me");
    await mkdir(join(dir, ".claude", "skills", "ship"), { recursive: true });
    await symlink(victim, path);
    await addEntry(dir, { name: "ship", type: "skill", path, createdAt: "2026-07-01", suggestionId: "x" });
    const suggestion: Suggestion = {
      ...base, name: "ship",
      payload: { type: "command", commandName: "ship", body: "replace victim" },
    };
    await expect(applySuggestion(suggestion, dir)).rejects.toThrow(/symlink/);
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });

  it("prints (does not write) a loop suggestion but still records it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const s: Suggestion = { ...base, name: "cont", payload: { type: "loop", instruction: "continue until done" } };
    const r = await applySuggestion(s, dir);
    expect(r.written).toBeUndefined();
    expect(r.printed).toContain("/loop");
    expect((await loadManifest(dir)).map(e => e.name)).toEqual(["cont"]);
  });
});
