import { describe, expect, it } from "vitest";
import { countArtifactUses } from "./usage.js";
import type { CommandEvent } from "./types.js";

const event = (ts: string, command: string): CommandEvent => ({
  ts,
  project: "p",
  sessionId: "s",
  command,
});

describe("countArtifactUses", () => {
  it("counts slash and non-slash command events since creation and tracks last use", () => {
    const events = [
      event("2026-07-01T00:00:00Z", "/ship"),
      event("2026-07-02T00:00:00Z", "ship"),
      event("2026-06-01T00:00:00Z", "/ship"),
    ];
    const uses = countArtifactUses(events, new Map([["ship", "2026-06-15"]]));
    expect(uses.get("ship")).toEqual({ uses: 2, lastUsed: "2026-07-02T00:00:00Z" });
  });

  it("counts multiple known commands but ignores unknown artifacts", () => {
    const uses = countArtifactUses([
      event("2026-07-01T00:00:00Z", "/ship"),
      event("2026-07-01T00:00:01Z", "/plan-v2"),
      event("2026-07-02T00:00:00Z", "/other"),
    ], new Map([
      ["ship", "2026-01-01"],
      ["plan-v2", "2026-01-01"],
    ]));
    expect(uses.get("ship")).toEqual({ uses: 1, lastUsed: "2026-07-01T00:00:00Z" });
    expect(uses.get("plan-v2")).toEqual({ uses: 1, lastUsed: "2026-07-01T00:00:01Z" });
    expect(uses.has("other")).toBe(false);
  });

  it("returns a zero row for every manifest artifact without a use", () => {
    const uses = countArtifactUses(
      [event("2026-07-01T00:00:00Z", "/other")],
      new Map([["ship", "2026-01-01"]]),
    );
    expect(uses.get("ship")).toEqual({ uses: 0, lastUsed: undefined });
  });
});
