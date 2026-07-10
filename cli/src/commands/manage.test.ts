import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyByIds } from "./apply.js";
import { list } from "./list.js";
import { remove } from "./remove.js";
import type { Suggestion } from "../core/types.js";
import { saveConfig } from "../config.js";

const ship: Suggestion = {
  id: "id-ship", name: "ship", title: "t", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "high",
  payload: { type: "command", commandName: "ship", body: "do it" },
};

async function seed(dir: string) {
  await mkdir(join(dir, ".gradient"), { recursive: true });
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([ship]));
}

describe("manage commands", () => {
  it("remove deletes the skill file and its emptied directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir);
    await applyByIds(["id-ship"], dir, { home });
    expect(await remove(dir, "ship")).toBe(true);
    await expect(stat(join(dir, ".claude", "skills", "ship"))).rejects.toThrow();
  });

  it("apply honors the configured command emit target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir);
    await saveConfig({ emitTarget: "command" }, home);
    const [applied] = await applyByIds(["id-ship"], dir, { home });
    expect(applied.written).toBe(join(dir, ".claude", "commands", "ship.md"));
  });

  it("applies by id, lists, then removes (unlinking the file)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir);
    const applied = await applyByIds(["id-ship"], dir, { home });
    expect(applied.length).toBe(1);
    expect(applied[0].written).toBe(join(dir, ".claude", "skills", "ship", "SKILL.md"));
    expect((await list(dir)).map(e => e.name)).toEqual(["ship"]);
    const ok = await remove(dir, "ship");
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
  });

  it("remove deletes a manifest-tracked project rule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
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
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([rule]));
    const [applied] = await applyByIds(["id-rule"], dir);
    expect(await remove(dir, "prefer-recommended")).toBe(true);
    await expect(access(applied.written!)).rejects.toThrow();
  });

  it("applies and removes a skill for both configured assistants", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await seed(dir);
    await saveConfig({ targets: ["claude-code", "codex"] }, home);
    const [applied] = await applyByIds(["id-ship"], dir, { home });
    expect(applied.writes.map(write => write.target)).toEqual(["claude-code", "codex"]);
    await expect(access(join(dir, ".claude", "skills", "ship", "SKILL.md"))).resolves.toBeUndefined();
    await expect(access(join(dir, ".agents", "skills", "ship", "SKILL.md"))).resolves.toBeUndefined();

    expect(await remove(dir, "ship")).toBe(true);
    await expect(stat(join(dir, ".claude", "skills", "ship"))).rejects.toThrow();
    await expect(stat(join(dir, ".agents", "skills", "ship"))).rejects.toThrow();
    expect(await list(dir)).toEqual([]);
  });
});
