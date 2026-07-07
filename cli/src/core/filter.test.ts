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
  it("keeps genuine prompts that start with a non-injected tag (JSX/HTML/XML)", () => {
    expect(isInjected("<div>why is this broken?</div>")).toBe(false);
    expect(isInjected("<Button> not rendering correctly")).toBe(false);
    expect(isInjected("<config> tag in my xml isn't parsing")).toBe(false);
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

import { classifyPrompt, classifyPrompts, compileIgnorePatterns } from "./filter.js";

const turn = (text: string): Turn =>
  ({ ts: "2026-07-01T00:00:00Z", project: "p", role: "user", sessionId: "s1", text });

describe("classifyPrompt", () => {
  it("classifies ordinary prompts as human", () => {
    expect(classifyPrompt("fix the login bug")).toBe("human");
  });
  it("keeps existing injected patterns as injected", () => {
    expect(classifyPrompt("<command-name>/compact</command-name>")).toBe("injected");
    expect(classifyPrompt("Caveat: The messages below were generated")).toBe("injected");
  });
  it("classifies continuation summaries", () => {
    expect(classifyPrompt("This session is being continued from a previous conversation that ran out of context.")).toBe("continuation");
  });
  it("classifies task notifications", () => {
    expect(classifyPrompt("<task-notification><task-id>x</task-id></task-notification>")).toBe("notification");
  });
  it("applies user ignore patterns as injected", () => {
    const ignore = compileIgnorePatterns(["^review this change for security vulnerabilities"]);
    expect(classifyPrompt("Review this change for security vulnerabilities. Changed files: a.ts", ignore)).toBe("injected");
  });
  it("compileIgnorePatterns skips invalid regexes", () => {
    expect(compileIgnorePatterns(["[unclosed", "^ok$"])).toHaveLength(1);
  });
});

describe("classifyPrompts / filterPrompts", () => {
  it("buckets by class and filterPrompts keeps only human", () => {
    const turns = [turn("do the thing"), turn("This session is being continued from a previous conversation."), turn("<task-notification>x</task-notification>")];
    const buckets = classifyPrompts(turns);
    expect(buckets.human).toHaveLength(1);
    expect(buckets.continuation).toHaveLength(1);
    expect(buckets.notification).toHaveLength(1);
    expect(filterPrompts(turns)).toHaveLength(1);
  });
});

import { isTemplateFlood, TEMPLATE_MIN_CHARS, TEMPLATE_MIN_COUNT } from "./filter.js";
import type { Candidate } from "./types.js";

const cand = (over: Partial<Candidate>): Candidate => ({
  kind: "unknown", signature: "x".repeat(300), examples: [], count: 30,
  sessions: 30, sessionIds: [], confidence: "high", ...over,
});

describe("isTemplateFlood", () => {
  it("flags long, high-volume, once-per-session clusters", () => {
    // The dogfood case: 1,318 CI-injected security-review prompts, one per session.
    expect(isTemplateFlood(cand({ count: 1318, sessions: 1318 }))).toBe(true);
  });
  it("spares short prompts regardless of volume (human habits are short)", () => {
    expect(isTemplateFlood(cand({ signature: "continue", count: 200, sessions: 100 }))).toBe(false);
  });
  it("spares low counts (single pastes, small repeats)", () => {
    expect(isTemplateFlood(cand({ count: TEMPLATE_MIN_COUNT - 1, sessions: TEMPLATE_MIN_COUNT - 1 }))).toBe(false);
  });
  it("spares within-session repetition (occurrences ≫ sessions = a human habit)", () => {
    expect(isTemplateFlood(cand({ count: 60, sessions: 10 }))).toBe(false);
  });
});
