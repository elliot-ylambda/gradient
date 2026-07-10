import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyByIds, suggestionsPath } from "./apply.js";
import { list } from "./list.js";
import { remove } from "./remove.js";
import type { Suggestion } from "../core/types.js";
import { saveConfig } from "../config.js";
import { loadArtifactApprovals } from "../core/approvals.js";

const ship: Suggestion = {
  id: "id-ship", name: "ship", title: "t", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "high",
  payload: { type: "command", commandName: "ship", body: "do it" },
};

async function seed(dir: string, home: string) {
  const path = suggestionsPath(dir, home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify([ship]));
}

describe("manage commands", () => {
  it("remove deletes the skill file and its emptied directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir, home);
    await applyByIds(["id-ship"], dir, { home });
    expect(await remove(dir, "ship", { home })).toBe(true);
    await expect(stat(join(dir, ".claude", "skills", "ship"))).rejects.toThrow();
    expect(await loadArtifactApprovals(dir, home)).toEqual([]);
  });

  it("apply honors the configured command emit target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir, home);
    await saveConfig({ emitTarget: "command" }, home);
    const [applied] = await applyByIds(["id-ship"], dir, { home });
    expect(applied.written).toBe(join(dir, ".claude", "commands", "ship.md"));
  });

  it("applies by id, lists, then removes (unlinking the file)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir, home);
    const applied = await applyByIds(["id-ship"], dir, { home });
    expect(applied.length).toBe(1);
    expect(applied[0].written).toBe(join(dir, ".claude", "skills", "ship", "SKILL.md"));
    expect((await list(dir)).map(e => e.name)).toEqual(["ship"]);
    const ok = await remove(dir, "ship", { home });
    expect(ok).toBe(true);
    await expect(access(applied[0].written!)).rejects.toThrow();
    expect(await list(dir)).toEqual([]);
  });

  it("refuses to unlink a manifest path outside .claude (tampered manifest)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await mkdir(join(dir, ".gradient"), { recursive: true });
    const victim = join(dir, "victim.txt"); // inside projectDir but OUTSIDE .claude
    await writeFile(victim, "keep me");
    await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify([
      { name: "evil", type: "command", path: victim, createdAt: "2026-06-29", suggestionId: "x" },
    ]));
    await expect(remove(dir, "evil")).rejects.toThrow();
    await expect(access(victim)).resolves.toBeUndefined(); // victim must survive
    await expect(list(dir)).rejects.toThrow(); // invalid manifest remains untouched
  });

  it("refuses a forged valid-looking manifest for a hand-written skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const skill = join(dir, ".claude", "skills", "personal", "SKILL.md");
    await mkdir(dirname(skill), { recursive: true });
    await writeFile(skill, "hand-written and irreplaceable\n");
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify([{
      name: "personal", type: "skill", path: skill,
      createdAt: "2026-07-01", suggestionId: "forged",
    }]));
    await expect(remove(dir, "personal")).rejects.toThrow(/provenance/);
    expect(await readFile(skill, "utf8")).toBe("hand-written and irreplaceable\n");
  });

  it("remove deletes a manifest-tracked project rule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const rule: Suggestion = {
      ...ship,
      id: "id-rule",
      name: "prefer-recommended",
      payload: {
        type: "rule",
        target: "project",
        ruleName: "prefer-recommended",
        text: "Default to the recommended option.",
      },
    };
    const path = suggestionsPath(dir, home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify([rule]));
    const [applied] = await applyByIds(["id-rule"], dir, { home });
    expect(await remove(dir, "prefer-recommended", { home })).toBe(true);
    await expect(access(applied.written!)).rejects.toThrow();
  });
});
