import { describe, expect, it } from "vitest";
import { commandHead, failureLoops, rituals, TOOLMINE } from "./toolmine.js";
import type { ToolEvent } from "./types.js";

let eventNumber = 0;
const bash = (
  command: string,
  isError: boolean,
  sessionId: string,
  errorHead = "err",
): ToolEvent => ({
  ts: `2026-07-01T00:00:${String(eventNumber++ % 60).padStart(2, "0")}Z`,
  sessionId,
  kind: "bash",
  command,
  isError,
  errorHead,
});
const edit = (sessionId: string, file = "/p/a.ts"): ToolEvent => ({
  ts: "2026-07-01T00:00:00Z",
  sessionId,
  kind: "edit",
  file,
});

describe("commandHead", () => {
  it("collapses whitespace and truncates to the configured maximum", () => {
    expect(commandHead("npm   test  --run")).toBe("npm test --run");
    expect(commandHead("x".repeat(TOOLMINE.HEAD_MAX + 20))).toHaveLength(TOOLMINE.HEAD_MAX);
  });
});

describe("failureLoops", () => {
  it("groups same-head failures across sessions into one toolfail candidate", () => {
    const events = [
      bash("npm test", true, "s1", "FAIL a"),
      bash("npm test", true, "s1", "FAIL b"),
      bash("npm test", true, "s2", "FAIL c"),
      bash("npm test", false, "s2"),
      bash("npm run build", true, "s1"),
    ];
    const [candidate, ...rest] = failureLoops(events);
    expect(rest).toEqual([]);
    expect(candidate.kind).toBe("toolfail");
    expect(candidate.signature).toBe("npm test");
    expect(candidate.count).toBe(3);
    expect(candidate.sessions).toBe(2);
    expect(candidate.examples).toEqual(["FAIL a", "FAIL b", "FAIL c"]);
  });

  it("requires failures in at least two sessions", () => {
    const events = [
      bash("npm test", true, "s1"),
      bash("npm test", true, "s1"),
      bash("npm test", true, "s1"),
    ];
    expect(failureLoops(events)).toEqual([]);
  });

  it("ignores empty commands and de-duplicates evidence examples", () => {
    const events = [
      bash("", true, "s1", "same"),
      bash("npm test", true, "s1", "same"),
      bash("npm test", true, "s1", "same"),
      bash("npm test", true, "s2", "same"),
    ];
    expect(failureLoops(events)[0].examples).toEqual(["same"]);
  });
});

describe("rituals", () => {
  const attached = (sessions = 3, observationsPerSession = 6, fillerPerSession = 2): ToolEvent[] => {
    const events: ToolEvent[] = [];
    for (let session = 1; session <= sessions; session++) {
      for (let index = 0; index < observationsPerSession; index++) {
        events.push(edit(`s${session}`), bash("npm run lint", false, `s${session}`));
      }
      for (let index = 0; index < fillerPerSession; index++) {
        events.push(edit(`s${session}`), bash(`echo ${session}-${index}`, false, `s${session}`));
      }
    }
    return events;
  };

  it("detects a command attached to edit windows", () => {
    const [candidate, ...rest] = rituals(attached());
    expect(rest).toEqual([]);
    expect(candidate.kind).toBe("ritual");
    expect(candidate.signature).toBe("npm run lint");
    expect(candidate.count).toBe(18);
    expect(candidate.sessions).toBe(3);
  });

  it("ignores frequent commands that do not follow edits", () => {
    const events: ToolEvent[] = [];
    for (let session = 1; session <= 3; session++) {
      for (let index = 0; index < 6; index++) events.push(bash("npm run lint", false, `s${session}`));
    }
    expect(rituals(events)).toEqual([]);
  });

  it("does not look past the configured event window", () => {
    const events: ToolEvent[] = [];
    for (let session = 1; session <= 3; session++) {
      for (let index = 0; index < 6; index++) {
        events.push(
          edit(`s${session}`),
          bash("a", false, `s${session}`),
          bash("b", false, `s${session}`),
          bash("c", false, `s${session}`),
          bash("npm run lint", false, `s${session}`),
        );
      }
    }
    expect(rituals(events).map(candidate => candidate.signature)).not.toContain("npm run lint");
  });

  it("requires the command to follow at least 40 percent of edit windows", () => {
    const events = attached(3, 5, 8);
    expect(events.filter(event => event.kind === "edit")).toHaveLength(39);
    expect(rituals(events).map(candidate => candidate.signature)).not.toContain("npm run lint");
  });
});
