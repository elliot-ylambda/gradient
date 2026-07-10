import { describe, expect, it } from "vitest";
import { countArtifactUses } from "./usage.js";
import type { Turn } from "./types.js";

const turn = (ts: string, text: string, role: "user" | "assistant" = "user"): Turn => ({
  ts,
  project: "p",
  role,
  sessionId: "s",
  text,
});

describe("countArtifactUses", () => {
  it("counts slash and non-slash command tags since creation and tracks last use", () => {
    const turns = [
      turn("2026-07-01T00:00:00Z", "<command-name>/ship</command-name> args"),
      turn("2026-07-02T00:00:00Z", "<command-name>ship</command-name>"),
      turn("2026-06-01T00:00:00Z", "<command-name>/ship</command-name>"),
      turn("2026-07-03T00:00:00Z", "plain prompt"),
    ];
    const uses = countArtifactUses(turns, new Map([["ship", "2026-06-15"]]));
    expect(uses.get("ship")).toEqual({ uses: 2, lastUsed: "2026-07-02T00:00:00Z" });
  });

  it("counts multiple known tags but ignores unknown artifacts and assistant turns", () => {
    const uses = countArtifactUses([
      turn("2026-07-01T00:00:00Z", "<command-name>/ship</command-name> <command-name>/plan-v2</command-name>"),
      turn("2026-07-02T00:00:00Z", "<command-name>/other</command-name>"),
      turn("2026-07-03T00:00:00Z", "<command-name>/ship</command-name>", "assistant"),
    ], new Map([
      ["ship", "2026-01-01"],
      ["plan-v2", "2026-01-01"],
    ]));
    expect(uses.get("ship")).toEqual({ uses: 1, lastUsed: "2026-07-01T00:00:00Z" });
    expect(uses.get("plan-v2")).toEqual({ uses: 1, lastUsed: "2026-07-01T00:00:00Z" });
    expect(uses.has("other")).toBe(false);
  });

  it("returns a zero row for every manifest artifact without a use", () => {
    const uses = countArtifactUses(
      [turn("2026-07-01T00:00:00Z", "<command-name>/other</command-name>")],
      new Map([["ship", "2026-01-01"]]),
    );
    expect(uses.get("ship")).toEqual({ uses: 0, lastUsed: undefined });
  });
});
