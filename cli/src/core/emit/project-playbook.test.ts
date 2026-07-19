import { describe, it, expect } from "vitest";
import { emitProjectPlaybook } from "./project-playbook.js";
import { emit } from "./index.js";
import type { Suggestion } from "../types.js";

const suggestion: Suggestion = {
  id: "abc123", name: "pb-build-after-tests", title: "Build after tests",
  rationale: "seen often", evidence: { count: 4, sessions: 3 }, confidence: "high",
  payload: { type: "project-playbook", section: "workflows", text: "After tests pass, run make build." },
};

describe("emitProjectPlaybook", () => {
  it("emits a tagged single-line bullet", () => {
    const out = emitProjectPlaybook(suggestion);
    expect(out.section).toBe("workflows");
    expect(out.line).toBe("- After tests pass, run make build. <!-- gradient:abc123 -->");
  });

  it("redacts secrets in the text", () => {
    const leaky = { ...suggestion, payload: { ...suggestion.payload, text: "Use api_key=supersecret123 after tests." } } as Suggestion;
    expect(emitProjectPlaybook(leaky).line).toContain("[REDACTED]");
    expect(emitProjectPlaybook(leaky).line).not.toContain("supersecret123");
  });

  it("dispatches through emit() as playbook-line and rejects the codex target", () => {
    expect(emit(suggestion)).toEqual({ kind: "playbook-line", section: "workflows", line: "- After tests pass, run make build. <!-- gradient:abc123 -->" });
    expect(() => emit(suggestion, { assistant: "codex" })).toThrow(/codex/);
  });
});
