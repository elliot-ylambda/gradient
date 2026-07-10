import { describe, it, expect } from "vitest";
import type { Suggestion } from "./types.js";
import type { SessionState, AutopilotLogEntry, Config } from "./types.js";

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

describe("autopilot types", () => {
  it("SessionState and Config autopilot keys compile with expected shapes", () => {
    const entry: AutopilotLogEntry = { ts: "2026-07-01T00:00:00Z", action: "continue", why: "unfinished", excerpt: "keep going" };
    const s: SessionState = { count: 1, attempts: 1, lastFingerprint: "tools:3", stoodDown: false, log: [entry] };
    const c: Config = { autopilot: "nudge", autopilotBudget: 10, autopilotModel: "haiku" };
    expect(s.log[0].action).toBe("continue");
    expect(c.autopilot).toBe("nudge");
  });
});
