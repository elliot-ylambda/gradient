import { describe, expect, it } from "vitest";
import type { ManifestEntry, Suggestion } from "../core/types.js";
import type { Dismissal } from "../core/dismiss.js";
import { MIN_SURFACE_MINUTES, sessionStart } from "./sessionStart.js";

function suggestion(name: string, minutes: number, count = 3): Suggestion {
  return {
    id: `${name}-id`, name, title: `${name} workflow`, rationale: "Observed",
    evidence: { count, sessions: 2, estMinutesSavedPerMonth: minutes },
    confidence: "high", sourceSignatures: [name],
    payload: { type: "command", commandName: name, body: "Do it" },
  };
}

function deps(
  suggestions: Suggestion[],
  manifest: ManifestEntry[] = [],
  dismissed: Dismissal[] = [],
) {
  return {
    loadSuggestionsFn: async () => suggestions,
    loadManifestFn: async () => manifest,
    loadDismissedFn: async () => dismissed,
  };
}

describe("sessionStart", () => {
  it("prints the highest-leverage eligible suggestion before spawning", async () => {
    const order: string[] = [];
    await sessionStart("/repo", {
      ...deps([suggestion("small", 6), suggestion("large", 20)]),
      write: line => order.push(`print:${line}`),
      spawnDetachedFn: (args, projectDir) => { order.push(`spawn:${args.join(" ")}:${projectDir}`); },
    });
    expect(order).toEqual([
      "print:gradient: large workflow (≈20m/month) — run `gradient review`",
      "spawn:scan:/repo",
    ]);
  });

  it("suppresses applied, dismissed, and below-floor suggestions", async () => {
    const applied = suggestion("applied", 30);
    const dismissedSuggestion = suggestion("dismissed", 20);
    const below = suggestion("below", MIN_SURFACE_MINUTES - 1);
    const output: string[] = [];
    let spawned = false;
    await sessionStart("/repo", {
      ...deps(
        [applied, dismissedSuggestion, below],
        [{ name: "applied", type: "skill", path: ".claude/skills/applied/SKILL.md", createdAt: "2026-07-01", suggestionId: applied.id }],
        [{ id: dismissedSuggestion.id, name: dismissedSuggestion.name, signatures: [dismissedSuggestion.name], dismissedAt: "2026-07-18T00:00:00Z" }],
      ),
      write: line => output.push(line),
      spawnDetachedFn: () => { spawned = true; },
    });
    expect(output).toEqual([]);
    expect(spawned).toBe(true);
  });

  it("fails open and still attempts the rescan when state loading throws", async () => {
    const output: string[] = [];
    let spawned = false;
    await expect(sessionStart("/repo", {
      loadSuggestionsFn: async () => { throw new Error("bad cache"); },
      write: line => output.push(line),
      spawnDetachedFn: () => { spawned = true; },
    })).resolves.toBeUndefined();
    expect(output).toEqual([]);
    expect(spawned).toBe(true);
  });

  it("resolves cleanly when detached spawning throws", async () => {
    const output: string[] = [];
    await expect(sessionStart("/repo", {
      ...deps([suggestion("ship", 9)]),
      write: line => output.push(line),
      spawnDetachedFn: () => { throw new Error("spawn failed"); },
    })).resolves.toBeUndefined();
    expect(output).toHaveLength(1);
  });
});
