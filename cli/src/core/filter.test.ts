import { describe, it, expect } from "vitest";
import { filterPrompts, isInjected } from "./filter.js";
import type { Turn } from "./types.js";

const u = (text: string): Turn => ({
  ts: "t", project: "p", role: "user", text, sessionId: "s",
});

describe("isInjected", () => {
  it("flags skill-loader and hook scaffolding", () => {
    expect(isInjected("Base directory for this skill: /x")).toBe(true);
    expect(isInjected("<command-name>/compact</command-name>")).toBe(true);
    expect(isInjected("<system-reminder>do x</system-reminder>")).toBe(true);
    expect(isInjected("Caveat: The messages below were generated")).toBe(true);
    expect(isInjected("[Request interrupted by user]")).toBe(true);
    expect(isInjected("local-command-stdout here")).toBe(true);
  });
  it("keeps genuine prompts", () => {
    expect(isInjected("push and create a pull request")).toBe(false);
  });
});

describe("filterPrompts", () => {
  it("drops injected, keeps genuine user prompts", () => {
    const turns = [u("Base directory for this skill: /x"), u("fix the bug"),
                   { ts: "t", project: "p", role: "user", sessionId: "s" } as Turn]; // no text → dropped
    const kept = filterPrompts(turns);
    expect(kept.map(t => t.text)).toEqual(["fix the bug"]);
  });
});
