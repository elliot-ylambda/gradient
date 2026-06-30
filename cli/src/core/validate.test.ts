import { describe, it, expect } from "vitest";
import { validateSuggestion, assertHookRunnable, KNOWN_SUBCOMMANDS } from "./validate.js";
import type { Suggestion } from "./types.js";

const good: Suggestion = {
  id: "x", name: "ship", title: "t", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "high",
  payload: { type: "command", commandName: "ship", body: "do it" },
};

describe("validateSuggestion", () => {
  it("accepts a well-formed suggestion", () => {
    expect(() => validateSuggestion(good)).not.toThrow();
  });
  it("rejects a missing payload", () => {
    expect(() => validateSuggestion({ ...good, payload: undefined })).toThrow();
  });
  it("rejects an unknown payload type", () => {
    expect(() => validateSuggestion({ ...good, payload: { type: "nope" } })).toThrow();
  });
  it("rejects a confidence outside the allowed set", () => {
    expect(() => validateSuggestion({ ...good, confidence: "medium" })).toThrow();
  });
});

describe("assertHookRunnable", () => {
  it("passes for a known subcommand", () => {
    const hook: Suggestion = { ...good, payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "d" } };
    expect(() => assertHookRunnable(hook)).not.toThrow();
  });
  it("throws for an unknown subcommand", () => {
    const hook: Suggestion = { ...good, payload: { type: "hook", event: "PreCompact", subcommand: "frobnicate", description: "d" } };
    expect(() => assertHookRunnable(hook)).toThrow();
  });
  it("exposes checkpoint as known", () => {
    expect(KNOWN_SUBCOMMANDS.has("checkpoint")).toBe(true);
  });
});
