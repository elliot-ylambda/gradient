import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadSuggestions, suggestionsPath } from "./apply.js";

describe("loadSuggestions", () => {
  it("keeps valid entries and reports unknown future payloads without crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-suggestions-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const path = suggestionsPath(dir, home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify([
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
    const suggestions = await loadSuggestions(dir, { home, onSkip: message => messages.push(message) });
    expect(suggestions.map(suggestion => suggestion.id)).toEqual(["ok"]);
    expect(messages.join("\n")).toContain("invalid cached suggestion");
    expect(messages.join("\n")).toContain("future-artifact");
  });

  it("returns an empty list for a non-array cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-suggestions-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const path = suggestionsPath(dir, home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{}");
    expect(await loadSuggestions(dir, { home })).toEqual([]);
  });

  // A cache written before the restatement filter shipped is indistinguishable
  // from a fresh one — the format is a bare array with no version stamp. Every
  // reader goes through here, including sessionStart, which injects what it
  // reads into a live session. Filtering on read is what stops an upgrade from
  // continuing to serve exactly what the upgrade exists to suppress.
  it("drops cached restatements written by an older release, and keeps the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-suggestions-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const path = suggestionsPath(dir, home);
    await mkdir(dirname(path), { recursive: true });
    const echo = "always run the full test suite before pushing";
    await writeFile(path, JSON.stringify([
      {
        id: "echo",
        name: "test-before-push",
        title: "Reusable workflow",
        rationale: "r",
        confidence: "high",
        evidence: { count: 4, sessions: 3 },
        examples: [echo],
        payload: { type: "command", commandName: "test-before-push", body: echo },
      },
      {
        id: "measured",
        name: "notify-when-waiting",
        title: "Desktop ping when Claude Code is waiting on you",
        rationale: "r",
        confidence: "high",
        evidence: { count: 8, sessions: 5, measured: true },
        payload: {
          type: "hook",
          event: "Notification",
          matcher: "permission_prompt|idle_prompt",
          subcommand: "notify",
          description: "Desktop notification when Claude needs input",
        },
      },
    ]));

    const messages: string[] = [];
    const suggestions = await loadSuggestions(dir, { home, onSkip: message => messages.push(message) });

    expect(suggestions.map(suggestion => suggestion.name)).toEqual(["notify-when-waiting"]);
    expect(messages.join("\n")).toContain("restate their own prompts");
  });
});
