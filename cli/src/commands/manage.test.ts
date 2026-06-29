import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyByIds } from "./apply.js";
import { list } from "./list.js";
import { remove } from "./remove.js";
import type { Suggestion } from "../core/types.js";

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
  it("applies by id, lists, then removes (unlinking the file)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await seed(dir);
    const applied = await applyByIds(["id-ship"], dir);
    expect(applied.length).toBe(1);
    expect((await list(dir)).map(e => e.name)).toEqual(["ship"]);
    const ok = await remove(dir, "ship");
    expect(ok).toBe(true);
    await expect(access(join(dir, ".claude/commands/ship.md"))).rejects.toThrow();
    expect(await list(dir)).toEqual([]);
  });
});
