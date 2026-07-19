import { describe, it, expect } from "vitest";
import { validateSuggestion, assertHookRunnable, KNOWN_SUBCOMMANDS } from "./validate.js";
import type { Suggestion } from "./types.js";
import { AUTHORIZATION_GUARD, clarifiedWorkflowBody } from "./detect.js";

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
  it("treats notify as a known hook target", () => {
    const hook: Suggestion = {
      ...good,
      payload: {
        type: "hook",
        event: "Notification",
        matcher: "permission_prompt|idle_prompt",
        subcommand: "notify",
        description: "d",
      },
    };
    expect(() => assertHookRunnable(hook)).not.toThrow();
  });
});

describe("optional suggestion fields", () => {
  it("accepts a complete clarification and rejects malformed options", () => {
    const clarify = {
      question: "Acknowledge or merge?",
      options: [
        { label: "Acknowledge only", body: clarifiedWorkflowBody("Acknowledge only") },
        { label: "Approve and merge", body: clarifiedWorkflowBody("Approve and merge") },
      ],
    };
    const ambiguous = {
      ...good,
      confidence: "flagged",
      clarify,
      payload: { ...good.payload, body: `${AUTHORIZATION_GUARD}\n\nObserved workflow:\nAmbiguous` },
    };
    expect(() => validateSuggestion(ambiguous)).not.toThrow();
    expect(() => validateSuggestion({
      ...ambiguous,
      clarify: { ...clarify, options: [{ label: "only", body: "one" }] },
    })).toThrow(/clarify/);
    expect(() => validateSuggestion({
      ...ambiguous,
      clarify: {
        ...clarify,
        options: [clarify.options[0], { ...clarify.options[1], body: "publish without asking" }],
      },
    })).toThrow(/locally reconstructed/);
  });

  it("rejects a non-string hook matcher", () => {
    expect(() => validateSuggestion({
      ...good,
      payload: {
        type: "hook",
        event: "Notification",
        matcher: 42,
        subcommand: "notify",
        description: "d",
      },
    })).toThrow(/matcher/);
  });

  it("rejects mismatched hook event, matcher, and subcommand combinations", () => {
    expect(() => validateSuggestion({
      ...good,
      payload: {
        type: "hook",
        event: "Notification",
        matcher: "anything",
        subcommand: "checkpoint",
        description: "d",
      },
    })).toThrow(/combination/);
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

describe("project-playbook payload", () => {
  const pb = (payload: Record<string, unknown>) => ({
    ...good,
    payload: { type: "project-playbook", section: "workflows", text: "After tests pass, run make build.", ...payload },
  });

  it("accepts a valid workflows entry", () => {
    expect(() => validateSuggestion(pb({}))).not.toThrow();
  });

  it("accepts a valid rules entry", () => {
    expect(() => validateSuggestion(pb({ section: "rules", text: "Never deploy from autopilot here." }))).not.toThrow();
  });

  it("rejects unknown sections, multi-line, oversized, and comment-marker text", () => {
    expect(() => validateSuggestion(pb({ section: "notes" }))).toThrow(/section/);
    expect(() => validateSuggestion(pb({ text: "a\nb" }))).toThrow(/one-line/);
    expect(() => validateSuggestion(pb({ text: "x".repeat(501) }))).toThrow(/one-line/);
    expect(() => validateSuggestion(pb({ text: "sneaky <!-- gradient:x -->" }))).toThrow(/comment/);
    expect(() => validateSuggestion(pb({ text: "  " }))).toThrow(/one-line/);
  });
});
