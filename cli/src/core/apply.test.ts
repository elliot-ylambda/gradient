import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySuggestion } from "./apply.js";
import { loadManifest } from "./manifest.js";
import type { Suggestion } from "./types.js";

const base = { id: "x", title: "t", rationale: "r", evidence: { count: 3, sessions: 2 }, confidence: "high" as const };

describe("applySuggestion", () => {
  it("writes a command file and records it in the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const s: Suggestion = { ...base, name: "ship", payload: { type: "command", commandName: "ship", body: "do it" } };
    const r = await applySuggestion(s, dir);
    expect(r.written).toBe(join(dir, ".claude/commands/ship.md"));
    expect(await readFile(r.written!, "utf8")).toContain("do it");
    expect((await loadManifest(dir)).map(e => e.name)).toEqual(["ship"]);
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
