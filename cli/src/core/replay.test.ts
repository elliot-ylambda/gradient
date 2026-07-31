import { describe, expect, it } from "vitest";
import { commandEventIdentity, dedupeReplayedEvents, toolEventIdentity } from "./replay.js";

describe("dedupeReplayedEvents", () => {
  it("counts one invocation replayed into several sessions once", () => {
    const compact = (sessionId: string) => ({ ts: "2026-07-01T00:00:00Z", command: "/compact", sessionId });
    const { kept, dropped } = dedupeReplayedEvents(
      [compact("parent"), compact("resumed"), compact("resumed-again")],
      commandEventIdentity,
    );
    expect(kept).toEqual([compact("parent")]);
    expect(dropped).toBe(2);
  });

  it("keeps genuinely separate invocations of the same command", () => {
    const { kept, dropped } = dedupeReplayedEvents([
      { ts: "2026-07-01T00:00:00Z", command: "/compact", sessionId: "s1" },
      { ts: "2026-07-01T00:00:01Z", command: "/compact", sessionId: "s1" },
    ], commandEventIdentity);
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("keeps different commands sharing an instant", () => {
    const { kept } = dedupeReplayedEvents([
      { ts: "2026-07-01T00:00:00Z", command: "/compact", sessionId: "s1" },
      { ts: "2026-07-01T00:00:00Z", command: "/model", sessionId: "s2" },
    ], commandEventIdentity);
    expect(kept).toHaveLength(2);
  });

  it("keeps events with no timestamp rather than guessing", () => {
    const { kept, dropped } = dedupeReplayedEvents([
      { ts: "", command: "/compact", sessionId: "s1" },
      { ts: "", command: "/compact", sessionId: "s2" },
    ], commandEventIdentity);
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("separates tool events by command and by file", () => {
    const { kept } = dedupeReplayedEvents([
      { ts: "2026-07-01T00:00:00Z", kind: "bash", command: "npm test", sessionId: "s1" },
      { ts: "2026-07-01T00:00:00Z", kind: "bash", command: "npm build", sessionId: "s1" },
      { ts: "2026-07-01T00:00:00Z", kind: "edit", file: "a.ts", sessionId: "s1" },
      { ts: "2026-07-01T00:00:00Z", kind: "edit", file: "b.ts", sessionId: "s1" },
      { ts: "2026-07-01T00:00:00Z", kind: "edit", file: "b.ts", sessionId: "resumed" },
    ], toolEventIdentity);
    expect(kept).toHaveLength(4);
  });
});
