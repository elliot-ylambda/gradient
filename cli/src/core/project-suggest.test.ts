import { describe, it, expect } from "vitest";
import {
  chainWorkflowSuggestion, nudgeRuleSuggestion, isConstraintShaped, mineProjectPlaybook,
} from "./project-suggest.js";
import type { ChainFinding } from "./sequence.js";
import type { Suggestion } from "./types.js";
import { validateSuggestion } from "./validate.js";

const chain = (over: Partial<ChainFinding> = {}): ChainFinding => ({
  steps: ["run the tests", "run make build"], count: 4, sessions: 3,
  sessionIds: ["s1", "s2", "s3"], examples: [], ...over,
});

const assistants = new Map([["s1", "claude-code"], ["s2", "codex"], ["s3", "claude-code"]] as const);

describe("chainWorkflowSuggestion", () => {
  it("produces a valid workflows suggestion with pooled assistants", () => {
    const s = chainWorkflowSuggestion(chain(), assistants);
    expect(s).not.toBeNull();
    validateSuggestion(s!);
    expect(s!.payload).toMatchObject({ type: "project-playbook", section: "workflows" });
    expect((s!.payload as { text: string }).text).toContain('After "run the tests"');
    expect(s!.evidence.assistants).toEqual(["claude-code", "codex"]);
  });

  it("returns null below the evidence thresholds", () => {
    expect(chainWorkflowSuggestion(chain({ count: 2 }), assistants)).toBeNull();
    expect(chainWorkflowSuggestion(chain({ sessions: 1, sessionIds: ["s1"] }), assistants)).toBeNull();
  });
});

describe("nudgeRuleSuggestion", () => {
  const nudge = (instruction: string, over: Partial<Suggestion> = {}): Suggestion => ({
    id: "n1", name: "keep-going", title: "t", rationale: "r",
    evidence: { count: 5, sessions: 3 }, confidence: "high",
    payload: { type: "loop", instruction }, ...over,
  });

  it("routes constraint-shaped nudges to a rules suggestion", () => {
    const s = nudgeRuleSuggestion(nudge("Never push directly to main."));
    expect(s).not.toBeNull();
    validateSuggestion(s!);
    expect(s!.payload).toMatchObject({ type: "project-playbook", section: "rules" });
  });

  it("ignores non-constraint nudges, scheduled loops, and weak evidence", () => {
    expect(nudgeRuleSuggestion(nudge("keep going until done"))).toBeNull();
    expect(nudgeRuleSuggestion(nudge("Never push.", { payload: { type: "loop", instruction: "Never push.", cadence: "daily" } }))).toBeNull();
    expect(nudgeRuleSuggestion(nudge("Never push.", { evidence: { count: 2, sessions: 1 } }))).toBeNull();
  });
});

describe("isConstraintShaped", () => {
  it("matches prohibition/requirement openers only", () => {
    expect(isConstraintShaped("Never deploy on Fridays")).toBe(true);
    expect(isConstraintShaped("Always run lint first")).toBe(true);
    expect(isConstraintShaped("don't touch prod")).toBe(true);
    expect(isConstraintShaped("please continue")).toBe(false);
  });
});

describe("mineProjectPlaybook", () => {
  it("combines both sources and dedupes by id", () => {
    const nudgeSuggestion: Suggestion = {
      id: "n1", name: "no-push", title: "t", rationale: "r",
      evidence: { count: 5, sessions: 3 }, confidence: "high",
      payload: { type: "loop", instruction: "Never push directly to main." },
    };
    const out = mineProjectPlaybook([nudgeSuggestion], [chain(), chain()], assistants);
    expect(out).toHaveLength(2); // 1 rule + 1 workflow (duplicate chain deduped)
    out.forEach(validateSuggestion);
  });
});
