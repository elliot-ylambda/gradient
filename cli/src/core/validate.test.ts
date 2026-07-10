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
  it("exposes recap as a known continuity hook target", () => {
    expect(KNOWN_SUBCOMMANDS.has("recap")).toBe(true);
  });
  it("treats a SessionStart→scan hook as runnable", () => {
    const s: any = { id: "x", name: "n", title: "t", rationale: "r", confidence: "high",
      payload: { type: "hook", event: "SessionStart", subcommand: "scan", description: "d" } };
    expect(() => assertHookRunnable(s)).not.toThrow();
  });
});

describe("triggers validation", () => {
  it("rejects non-string triggers", () => {
    const s = { id: "1", name: "n", title: "t", rationale: "r", confidence: "high",
      payload: { type: "command", commandName: "n", body: "b", triggers: [1] } };
    expect(() => validateSuggestion(s)).toThrow(/triggers/);
  });
  it("accepts string triggers and absent triggers", () => {
    const base = { id: "1", name: "n", title: "t", rationale: "r", confidence: "high", evidence: { count: 1, sessions: 1 },
      payload: { type: "command", commandName: "n", body: "b" } };
    expect(() => validateSuggestion(base)).not.toThrow();
    expect(() => validateSuggestion({ ...base, payload: { ...base.payload, triggers: ["x"] } })).not.toThrow();
  });
});

describe("mechanical validation", () => {
  it("accepts boolean or absent mechanical and rejects other values", () => {
    expect(() => validateSuggestion(good)).not.toThrow();
    expect(() => validateSuggestion({
      ...good,
      payload: { ...good.payload, mechanical: true },
    })).not.toThrow();
    expect(() => validateSuggestion({
      ...good,
      payload: { ...good.payload, mechanical: "yes" },
    })).toThrow(/mechanical/);
  });
});

describe("rule validation", () => {
  const base = { id: "1", name: "n", title: "t", rationale: "r", confidence: "high", evidence: { count: 3, sessions: 2 } };

  it("accepts a complete rule payload", () => {
    expect(() => validateSuggestion({
      ...base,
      payload: { type: "rule", target: "project", ruleName: "n", text: "t" },
    })).not.toThrow();
  });

  it("rejects invalid targets and missing text", () => {
    expect(() => validateSuggestion({
      ...base,
      payload: { type: "rule", target: "everyone", ruleName: "n", text: "t" },
    })).toThrow(/target/);
    expect(() => validateSuggestion({
      ...base,
      payload: { type: "rule", target: "project", ruleName: "n" },
    })).toThrow(/text/);
  });

  it("rejects unsafe names, control characters, empty text, and oversized text", () => {
    expect(() => validateSuggestion({
      ...base, payload: { type: "rule", target: "project", ruleName: "Not Safe", text: "t" },
    })).toThrow(/ruleName/);
    expect(() => validateSuggestion({
      ...base, payload: { type: "rule", target: "project", ruleName: "n", text: "bad\u001btext" },
    })).toThrow(/text/);
    expect(() => validateSuggestion({
      ...base, payload: { type: "rule", target: "project", ruleName: "n", text: "   " },
    })).toThrow(/text/);
    expect(() => validateSuggestion({
      ...base, payload: { type: "rule", target: "project", ruleName: "n", text: "x".repeat(2_001) },
    })).toThrow(/text/);
  });
});
