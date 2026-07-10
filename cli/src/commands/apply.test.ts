import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSuggestions } from "./apply.js";

describe("loadSuggestions", () => {
  it("keeps valid entries and reports unknown future payloads without crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-suggestions-"));
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([
      {
        id: "ok",
        name: "ship",
        title: "Ship",
        rationale: "r",
        confidence: "high",
        evidence: { count: 3, sessions: 2 },
        payload: { type: "command", commandName: "ship", body: "ship it" },
      },
      {
        id: "future",
        name: "future",
        title: "Future",
        rationale: "r",
        confidence: "high",
        evidence: { count: 3, sessions: 2 },
        payload: { type: "future-artifact" },
      },
    ]));
    const messages: string[] = [];
    const suggestions = await loadSuggestions(dir, message => messages.push(message));
    expect(suggestions.map(suggestion => suggestion.id)).toEqual(["ok"]);
    expect(messages.join("\n")).toContain("invalid cached suggestion");
    expect(messages.join("\n")).toContain("future-artifact");
  });

  it("returns an empty list for a non-array cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-suggestions-"));
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), "{}");
    expect(await loadSuggestions(dir)).toEqual([]);
  });
});
