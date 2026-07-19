import { describe, expect, it } from "vitest";
import type { ManifestEntry, Suggestion } from "../core/types.js";
import type { Dismissal } from "../core/dismiss.js";
import { MIRROR_MAX_AGE_MS, mirror } from "./mirror.js";

function suggestion(name: string, minutes: number): Suggestion {
  return {
    id: `${name}-id`, name, title: `${name} workflow`, rationale: "Observed",
    evidence: { count: 3, sessions: 2, estMinutesSavedPerMonth: minutes },
    confidence: "high", sourceSignatures: [name],
    payload: { type: "command", commandName: name, body: "Do it" },
  };
}

const noManifest = async (): Promise<ManifestEntry[]> => [];
const noDismissals = async (): Promise<Dismissal[]> => [];

describe("mirror", () => {
  it("uses a fresh cache without rescanning and shows at most three by leverage", async () => {
    const now = Date.parse("2026-07-18T12:00:00Z");
    const output: string[] = [];
    let scans = 0;
    await mirror("/repo", {
      now,
      cacheMtimeFn: async () => now - MIRROR_MAX_AGE_MS + 1,
      loadSuggestionsFn: async () => [
        suggestion("one", 1), suggestion("four", 4), suggestion("two", 2), suggestion("three", 3),
      ],
      loadManifestFn: noManifest,
      loadDismissedFn: noDismissals,
      scanFn: async () => { scans++; return []; },
      write: line => output.push(line),
    });
    expect(scans).toBe(0);
    expect(output.join("\n")).toContain("four workflow");
    expect(output.join("\n")).not.toContain("one workflow");
    expect(output.at(-1)).toContain("gradient review");
  });

  it("runs a bounded user-scope scan when the cache is missing", async () => {
    const calls: unknown[] = [];
    const output: string[] = [];
    await mirror("/repo", {
      home: "/home",
      cacheMtimeFn: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      loadConfigFn: async () => ({ userScopeDays: 9 }),
      scanFn: async (options) => { calls.push(options); return [suggestion("ship", 8)]; },
      loadManifestFn: noManifest,
      loadDismissedFn: noDismissals,
      write: line => output.push(line),
    });
    expect(calls).toEqual([expect.objectContaining({
      scope: "all", projectPath: "/repo", sinceDays: 9, home: "/home",
    })]);
    expect(output.join("\n")).toContain("ship workflow");
  });

  it("hides applied and dismissed suggestions", async () => {
    const now = Date.now();
    const applied = suggestion("applied", 20);
    const dismissed = suggestion("dismissed", 10);
    const output: string[] = [];
    await mirror("/repo", {
      now,
      cacheMtimeFn: async () => now,
      loadSuggestionsFn: async () => [applied, dismissed],
      loadManifestFn: async () => [{
        name: "applied", type: "skill", path: ".claude/skills/applied/SKILL.md",
        createdAt: "2026-07-01", suggestionId: applied.id,
      }],
      loadDismissedFn: async () => [{
        id: dismissed.id, name: dismissed.name, signatures: [dismissed.name], dismissedAt: "2026-07-18T00:00:00Z",
      }],
      write: line => output.push(line),
    });
    expect(output).toEqual(["gradient: no pending suggestions"]);
  });
});
