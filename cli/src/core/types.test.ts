import { describe, it, expect } from "vitest";
import type { Suggestion } from "./types.js";

describe("types", () => {
  it("constructs a command suggestion", () => {
    const s: Suggestion = {
      id: "abc",
      name: "ship",
      title: "Push + open PR + review",
      rationale: "seen 13x",
      evidence: { count: 13, sessions: 9 },
      confidence: "high",
      payload: { type: "command", commandName: "ship", body: "Push and open a PR." },
    };
    expect(s.payload.type).toBe("command");
  });
});
