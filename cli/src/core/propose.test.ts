import { describe, it, expect } from "vitest";
import {
  AUTHORIZATION_GUARD,
  byLeverage,
  candidateToCommand,
  candidateToLoop,
  idFor,
  MAX_PROPOSE_CANDIDATES,
  mergeNearDuplicates,
  propose,
} from "./propose.js";
import type { Candidate, Suggestion } from "./types.js";
import { CORRECTION_S } from "./leverage.js";

const cand = (signature: string, count: number, confidence: any = "high"): Candidate => ({
  kind: "unknown",
  signature,
  examples: [signature],
  count,
  sessions: count,
  sessionIds: Array.from({ length: count }, (_, i) => `s${i}`),
  occurrences: Array.from({ length: count }, (_, i) => ({ ts: `2026-06-01T10:0${i % 10}:00Z`, sessionId: `s${i}` })),
  memberSignatures: [signature],
  confidence,
});

// A long, low-count-but-high-leverage candidate vs. a short, higher-count-but-
// low-leverage one, both spanning the same 30 days — used to prove ranking
// follows estimated leverage rather than raw count.
const highLeverageCand = (): Candidate => ({
  kind: "unknown", signature: "x".repeat(1000), examples: ["x".repeat(1000)],
  count: 5, sessions: 5, sessionIds: ["s0", "s1", "s2", "s3", "s4"],
  occurrences: [{ ts: "2026-06-01T00:00:00Z", sessionId: "s0" }, { ts: "2026-07-01T00:00:00Z", sessionId: "s1" }],
  memberSignatures: ["x".repeat(1000)], confidence: "high",
});
const lowLeverageCand = (): Candidate => ({
  kind: "unknown", signature: "y".repeat(10), examples: ["y".repeat(10)],
  count: 6, sessions: 6, sessionIds: ["s0", "s1", "s2", "s3", "s4", "s5"],
  occurrences: [{ ts: "2026-06-01T00:00:00Z", sessionId: "s0" }, { ts: "2026-07-01T00:00:00Z", sessionId: "s1" }],
  memberSignatures: ["y".repeat(10)], confidence: "high",
});

describe("candidateToCommand", () => {
  it("derives a guarded reusable command", () => {
    const s = candidateToCommand(cand("merge main into this pr", 9));
    expect(s.payload.type).toBe("command");
    if (s.payload.type === "command") {
      expect(s.payload.commandName).toBe("merge-main-into");
      expect(s.payload.triggers).toEqual(["merge main into this pr"]);
      expect(s.payload.body).toContain("no standing authorization");
      expect(s.payload.body).toContain("merge main into this pr");
    }
  });

  it("redacts a signature everywhere in degraded suggestions", () => {
    const suggestion = candidateToCommand(cand("ANTHROPIC_API_KEY=sk-ant-abc123 make dev", 3));
    expect(JSON.stringify(suggestion)).not.toContain("sk-ant-abc123");
    expect(JSON.stringify(suggestion)).toContain("[REDACTED]");
  });

  it("keeps sequence order but treats it as a checklist, not authorization", () => {
    const sequence: Candidate = {
      ...cand("review the spec → write the plan", 3),
      kind: "sequence",
      examples: ["review the spec ⏎ write the plan"],
    };
    const suggestion = candidateToCommand(sequence);
    expect(suggestion.payload).toMatchObject({ type: "command", triggers: ["review the spec"] });
    if (suggestion.payload.type === "command") {
      expect(suggestion.payload.body).toContain("1. review the spec\n2. write the plan");
      expect(suggestion.payload.body).toContain("not permission");
      expect(suggestion.payload.body).toContain("ask which steps");
    }
  });

  it("never instructs a paste guide to rerun the observed command", () => {
    const paste: Candidate = { ...cand("make dev", 3), kind: "paste" };
    const suggestion = candidateToCommand(paste);
    if (suggestion.payload.type !== "command") throw new Error("expected command");
    expect(suggestion.payload.body).toContain("Advisory only");
    expect(suggestion.payload.body).toContain("do not rerun a command");
    expect(suggestion.payload.triggers).toEqual(["help with make dev"]);
  });

  it("keeps titles one line and display-bounded for pathological signatures", () => {
    const noisy = cand(`# a long pasted heading\nwith continuation lines ${"x".repeat(500)}`, 3);
    const suggestion = candidateToCommand(noisy);
    expect(suggestion.title).not.toContain("\n");
    expect(suggestion.title.length).toBeLessThanOrEqual(160);
  });

  it("carries sourceSignatures from the candidate's own memberSignatures", () => {
    const s = candidateToCommand(cand("merge main into this pr", 9));
    expect(s.sourceSignatures).toEqual(["merge main into this pr"]);
  });

  it("falls back to the raw signature for sourceSignatures when memberSignatures is empty", () => {
    const paste: Candidate = { ...cand("make dev", 3), kind: "paste", memberSignatures: [] };
    const s = candidateToCommand(paste);
    expect(s.sourceSignatures).toEqual(["make dev"]);
  });

  it("stores a sorted, unique, redacted, non-empty signature set", () => {
    const source = cand("fallback", 3);
    source.memberSignatures = [" z ", "a", "a", "\n", "email person@example.com"];
    const suggestion = candidateToCommand(source);
    expect(suggestion.sourceSignatures).toEqual([
      "a",
      "email [REDACTED]",
      "z",
    ]);
  });

  it("includes an estimated minutes-saved-per-month in evidence", () => {
    const s = candidateToCommand(cand("merge main into this pr", 9));
    expect(s.evidence.estMinutesSavedPerMonth).toBe(14);
  });
});

describe("candidateToLoop", () => {
  it("derives a guarded loop suggestion from a loop-kind candidate", () => {
    const loop: Candidate = { ...cand("run the test suite and report failures", 8), kind: "loop" };
    const s = candidateToLoop(loop);
    expect(s.payload.type).toBe("loop");
    if (s.payload.type === "loop") {
      expect(s.payload.instruction).toContain("no standing authorization");
      expect(s.payload.instruction).toContain("run the test suite and report failures");
    }
  });

  it("passes cadence through from the candidate", () => {
    const loop: Candidate = {
      ...cand("check the dashboard", 8), kind: "loop", cadence: "0 9 * * *",
      temporal: { maxRunLength: 1, runSessions: 0, medianGapMinutes: 1_440, distinctDays: 8, spanDays: 9 },
    };
    const s = candidateToLoop(loop);
    expect(s.payload).toMatchObject({ type: "loop", cadence: "0 9 * * *" });
    expect(s.rationale).toContain("8 active day(s)");
  });

  it("falls back to a command payload when the instruction contains a consequential action", () => {
    const loop: Candidate = { ...cand("deploy to production", 8), kind: "loop" };
    const s = candidateToLoop(loop);
    expect(s.payload.type).toBe("command");
    expect(s).toEqual(candidateToCommand(loop));
  });

  it("redacts a signature everywhere in the loop suggestion", () => {
    const loop: Candidate = { ...cand("ANTHROPIC_API_KEY=sk-ant-abc123 run the loop", 8), kind: "loop" };
    const s = candidateToLoop(loop);
    expect(JSON.stringify(s)).not.toContain("sk-ant-abc123");
    expect(JSON.stringify(s)).toContain("[REDACTED]");
  });
});
describe("propose", () => {
  const kinded = (kind: Candidate["kind"], signature: string, count = 5): Candidate =>
    ({ ...cand(signature, count), kind });

  it("maps every candidate kind to an artifact with no model involved", () => {
    const shapeOf = (kind: Candidate["kind"], signature: string): string | null =>
      propose([kinded(kind, signature)])[0]?.payload.type ?? null;
    expect(shapeOf("unknown", "write the implementation plan")).toBe("command");
    expect(shapeOf("paste", "make dev")).toBe("command");
    expect(shapeOf("sequence", "run tests → open a pr")).toBe("command");
    expect(shapeOf("toolfail", "npm test")).toBe("rule");
    expect(shapeOf("ritual", "npm run lint")).toBe("hook");
    expect(shapeOf("correction", "don't add comments")).toBe("rule");
    expect(shapeOf("answer", "pnpm ← Which package manager do you prefer?")).toBe("rule");
    expect(shapeOf("loop", "continue")).toBe("loop");
  });

  it("turns a recurring failure loop into a preventive rule, not a skill", () => {
    const [out] = propose([kinded("toolfail", "npm test")]);
    expect(out.payload).toMatchObject({ type: "rule", target: "project" });
    if (out.payload.type === "rule") {
      expect(out.payload.text).toContain("npm test");
      expect(out.payload.text).toContain("not authorization");
    }
    expect(out.title).toContain("Prevent recurring failure");
    expect(out.evidence.measured).toBe(true);
  });

  it("turns a safe post-edit ritual into a PostToolUse hook", () => {
    const [out] = propose([kinded("ritual", "npm run lint")]);
    expect(out.payload).toEqual({
      type: "hook",
      event: "PostToolUse",
      matcher: "Edit|Write|NotebookEdit",
      command: "npm run lint",
      description: "Run the observed command automatically after file edits.",
    });
    expect(out.evidence.measured).toBe(true);
  });

  it("keeps a consequential ritual out of an unattended hook", () => {
    const [out] = propose([kinded("ritual", "git push origin main")]);
    expect(out.payload.type).toBe("command");
    if (out.payload.type === "command") {
      expect(out.payload.body).toContain(AUTHORIZATION_GUARD);
      expect(out.payload.body).toContain("git push origin main");
    }
  });

  it("emits a loop for a loop-kind candidate and refuses one for a consequential instruction", () => {
    const loop = {
      ...kinded("loop", "continue", 8),
      temporal: { maxRunLength: 4, runSessions: 3, medianGapMinutes: 5, distinctDays: 3, spanDays: 2 },
    };
    expect(propose([loop])).toEqual([candidateToLoop(loop)]);

    const [consequential] = propose([kinded("loop", "deploy to production")]);
    expect(consequential.payload.type).toBe("command");
  });

  it("turns a repeated correction into a guarded rule", () => {
    const [out] = propose([kinded("correction", "don't add comments")]);
    expect(out.payload).toMatchObject({ type: "rule", target: "project" });
    if (out.payload.type === "rule") {
      expect(out.payload.text).toContain("don't add comments");
      expect(out.payload.text).toContain("not authorization");
    }
  });

  it("names an answer rule after the answer and drops one with no question split", () => {
    const [out] = propose([kinded("answer", "pnpm ← Which package manager do you prefer?")]);
    expect(out.name).toBe("pnpm");
    expect(out.payload).toMatchObject({ type: "rule", ruleName: "pnpm" });
    expect(propose([kinded("answer", "pnpm with no split at all")])).toEqual([]);
  });

  it("marks tool-event evidence measured and prompt-derived evidence not", () => {
    const [tool] = propose([kinded("toolfail", "npm test")]);
    const [prompt] = propose([kinded("unknown", "write the implementation plan")]);
    expect(tool.evidence.measured).toBe(true);
    expect(prompt.evidence.measured).toBeUndefined();
  });

  it("caps the window, reports what it dropped, and never exceeds the absolute cap", () => {
    let dropped = -1;
    const sources = Array.from({ length: 20 }, (_, i) => cand(`p${i}`, 20 - i));
    expect(propose(sources, { limit: 5, onCap: value => (dropped = value) })).toHaveLength(5);
    expect(dropped).toBe(15);

    const many = Array.from({ length: MAX_PROPOSE_CANDIDATES + 20 }, (_, i) => cand(`p${i}`, 200 - i));
    expect(propose(many, { limit: Number.MAX_SAFE_INTEGER })).toHaveLength(MAX_PROPOSE_CANDIDATES);
  });

  it("orders by estimated leverage rather than raw count, and keeps leverage in a size-limited window", () => {
    const out = propose([lowLeverageCand(), highLeverageCand()]);
    expect(out.map(s => s.evidence.count)).toEqual([5, 6]);
    expect(out[0].evidence.estMinutesSavedPerMonth!).toBeGreaterThan(out[1].evidence.estMinutesSavedPerMonth!);

    const capped = propose([lowLeverageCand(), highLeverageCand()], { limit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0].evidence.count).toBe(5);
  });

  it("keeps ids stable regardless of candidate scan order", () => {
    const a = cand("first workflow", 5);
    const b = cand("second workflow", 4);
    const inOrder = propose([a, b]).map(s => s.id);
    const reordered = propose([b, a]).map(s => s.id);
    expect(inOrder).toHaveLength(2);
    expect(new Set(inOrder)).toEqual(new Set(reordered));
  });

  // Names become file paths. Two candidates whose first three words agree would
  // otherwise have one artifact overwrite the other on apply.
  it("suffixes a colliding name, and the suffix reaches the payload", () => {
    const out = propose([
      kinded("unknown", "don't add comments anywhere"),
      kinded("correction", "don't add comments anywhere"),
    ]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map(s => s.name)).size).toBe(2);
    for (const suggestion of out) {
      const inner = suggestion.payload.type === "command"
        ? suggestion.payload.commandName
        : suggestion.payload.type === "rule" ? suggestion.payload.ruleName : suggestion.name;
      expect(inner).toBe(suggestion.name);
    }
  });

  // Dogfood regression: `git -C <path> status` named the artifact after the
  // path it was pointed at, not the habit, and spent the whole 40-char budget.
  it("names an artifact after the habit, not the path or flags it carried", () => {
    const [out] = propose([kinded("toolfail", "git -C /Users/x/projects/marketing status")]);
    expect(out.name).toBe("git-status");
    expect(out.payload).toMatchObject({ ruleName: "git-status" });

    // A signature that is nothing but noise still has to produce a usable name.
    const [allNoise] = propose([kinded("toolfail", "/usr/local/bin/thing")]);
    expect(allNoise.name).not.toBe("untitled");
  });

  it("redacts secrets everywhere in the emitted artifact", () => {
    const out = propose([cand(`deploy with npm_${"a".repeat(36)}`, 5)]);
    expect(JSON.stringify(out)).not.toContain("npm_aaaa");
    expect(JSON.stringify(out)).toContain("[REDACTED]");
  });

  // The `mechanical` flag used to require the model to volunteer it; the three
  // local predicates were always the real test, and now they run alone.
  it("pins a mechanical workflow to the cheap model and leaves judgment work alone", () => {
    const [mechanical] = propose([cand("reformat and lint the touched files", 5)]);
    expect(mechanical.payload).toMatchObject({ mechanical: true });

    const [judgment] = propose([cand("review the plan and lint it after", 5)]);
    expect(judgment.payload).not.toHaveProperty("mechanical");
  });
});

describe("mergeNearDuplicates", () => {
  const baseEvidence = { count: 5, sessions: 5, estMinutesSavedPerMonth: 5 };
  const candidate = (signature: string, kind: Candidate["kind"] = "unknown", count = 5): Candidate => ({
    kind, signature, examples: [signature], count, sessions: 2, sessionIds: ["s1", "s2"],
    occurrences: [{ ts: "2026-06-01T10:00:00Z", sessionId: "s1" }],
    memberSignatures: [signature], confidence: "high",
  });
  const commandSuggestion = (id: string, name: string, signature: string, trigger = signature): Suggestion => ({
    id, name, title: "t", rationale: "r", confidence: "high", evidence: baseEvidence,
    sourceSignatures: signature ? [signature] : [],
    payload: { type: "command", commandName: name, body: "x", triggers: [trigger] },
  });

  // Counter-test: identical distinctive text must still not merge a loop with
  // a command — the payload-type gate must be checked before similarity.
  it("does not merge a loop and a command sharing identical distinctive text", () => {
    const loop: Suggestion = {
      id: "loop1", name: "run-the-tests", title: "t", rationale: "r", confidence: "high",
      evidence: baseEvidence,
      sourceSignatures: ["run the tests (loop)"],
      payload: { type: "loop", instruction: `${AUTHORIZATION_GUARD} Reminder: run the tests` },
    };
    const command: Suggestion = {
      id: "cmd1", name: "run-the-tests", title: "t", rationale: "r", confidence: "high",
      evidence: baseEvidence,
      sourceSignatures: ["run the tests (command)"],
      payload: { type: "command", commandName: "run-the-tests", body: "irrelevant", triggers: ["run the tests"] },
    };
    const out = mergeNearDuplicates([loop, command], new Map());
    expect(out).toHaveLength(2);
  });

  // Guard test: two unrelated commands whose bodies share only the fixed
  // AUTHORIZATION_GUARD boilerplate must not merge. Their full bodies are
  // highly similar (same ~300-char guard dominates), but mergeText must
  // compare only name + triggers, which are unrelated here.
  it("does not merge two unrelated commands that share only the AUTHORIZATION_GUARD boilerplate", () => {
    const a: Suggestion = {
      id: "a", name: "deploy-staging", title: "t", rationale: "r", confidence: "high",
      evidence: baseEvidence,
      sourceSignatures: ["deploy the app to staging"],
      payload: {
        type: "command", commandName: "deploy-staging",
        body: `${AUTHORIZATION_GUARD}\n\nObserved workflow:\ndeploy the app to staging`,
        triggers: ["deploy the app to staging"],
      },
    };
    const b: Suggestion = {
      id: "b", name: "write-parser-tests", title: "t", rationale: "r", confidence: "high",
      evidence: baseEvidence,
      sourceSignatures: ["write unit tests for the parser"],
      payload: {
        type: "command", commandName: "write-parser-tests",
        body: `${AUTHORIZATION_GUARD}\n\nObserved workflow:\nwrite unit tests for the parser`,
        triggers: ["write unit tests for the parser"],
      },
    };
    const out = mergeNearDuplicates([a, b], new Map());
    expect(out).toHaveLength(2);
  });

  it("does not merge unrelated triggers merely because model names match", () => {
    const a = commandSuggestion("a", "routine", "deploy staging");
    const b = commandSuggestion("b", "routine-copy", "write parser tests");
    const bySignature = new Map([
      ["deploy staging", candidate("deploy staging")],
      ["write parser tests", candidate("write parser tests")],
    ]);
    expect(mergeNearDuplicates([a, b], bySignature)).toHaveLength(2);
  });

  it("merges the lgtm/looks-good synonym even under unrelated model names", () => {
    const a = commandSuggestion("a", "ack", "lgtm");
    const b = commandSuggestion("b", "review-finished", "looks good");
    const bySignature = new Map([
      ["lgtm", candidate("lgtm")],
      ["looks good", candidate("looks good")],
    ]);
    expect(mergeNearDuplicates([a, b], bySignature)).toHaveLength(1);
  });

  it("does not merge empty or unresolvable provenance", () => {
    const emptyA = commandSuggestion("a", "same", "", "same trigger");
    const emptyB = commandSuggestion("b", "same-copy", "", "same trigger");
    expect(mergeNearDuplicates([emptyA, emptyB], new Map())).toHaveLength(2);

    const missingA = commandSuggestion("c", "same", "missing-a", "same trigger");
    const missingB = commandSuggestion("d", "same-copy", "missing-b", "same trigger");
    expect(mergeNearDuplicates([missingA, missingB], new Map())).toHaveLength(2);
  });

  it("counts one candidate once when multiple member signatures resolve to it", () => {
    const owner = candidate("primary", "unknown", 5);
    owner.memberSignatures = ["primary", "alias"];
    const a = commandSuggestion("a", "same", "primary", "same trigger");
    const b = commandSuggestion("b", "same-copy", "alias", "same trigger");
    const [merged] = mergeNearDuplicates([a, b], new Map([["primary", owner], ["alias", owner]]));
    expect(merged.evidence.count).toBe(5);
  });

  it("keeps command/rule subtypes, loop schedule shape, and hook tuples separate", () => {
    const paste = commandSuggestion("p", "workflow", "paste", "same trigger");
    const sequence = commandSuggestion("s", "workflow-copy", "sequence", "same trigger");
    const candidates = new Map([
      ["paste", candidate("paste", "paste")],
      ["sequence", candidate("sequence", "sequence")],
    ]);
    expect(mergeNearDuplicates([paste, sequence], candidates)).toHaveLength(2);

    const scheduled: Suggestion = {
      id: "l1", name: "daily-check", title: "t", rationale: "r", confidence: "high", evidence: baseEvidence,
      sourceSignatures: ["daily"], payload: { type: "loop", instruction: "same", cadence: "0 9 * * *" },
    };
    const unscheduled: Suggestion = {
      ...scheduled, id: "l2", name: "daily-check-copy", sourceSignatures: ["run"],
      payload: { type: "loop", instruction: "same" },
    };
    expect(mergeNearDuplicates([scheduled, unscheduled], new Map())).toHaveLength(2);

    const checkpoint: Suggestion = {
      id: "h1", name: "checkpoint", title: "t", rationale: "r", confidence: "high", evidence: baseEvidence,
      sourceSignatures: ["h1"], payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "same" },
    };
    const notify: Suggestion = {
      ...checkpoint, id: "h2", name: "checkpoint-copy", sourceSignatures: ["h2"],
      payload: { type: "hook", event: "Notification", subcommand: "notify", description: "same" },
    };
    expect(mergeNearDuplicates([checkpoint, notify], new Map())).toHaveLength(2);
  });

  // Ambiguity must survive a merge: folding a flagged suggestion (with its
  // clarify) into a confident host keeps the flag and adopts the clarify —
  // otherwise the disambiguation the flag existed to force silently vanishes.
  it("keeps the more cautious confidence on merge", () => {
    const host: Suggestion = {
      id: "host", name: "approve-pr", title: "t", rationale: "Observed 5× across 5 distinct sessions; generated content is reconstructed locally.",
      confidence: "high",
      evidence: { count: 5, sessions: 5, estMinutesSavedPerMonth: 9 },
      sourceSignatures: ["approve the pr"],
      payload: { type: "command", commandName: "approve-pr", body: "x", triggers: ["approve the pr"] },
    };
    const flaggedDup: Suggestion = {
      id: "dup", name: "approve-pr-too", title: "t", rationale: "r",
      confidence: "flagged",
      evidence: { count: 3, sessions: 2, estMinutesSavedPerMonth: 4 },
      sourceSignatures: ["approve this pr"],
      payload: { type: "command", commandName: "approve-pr-too", body: "x", triggers: ["approve this pr"] },
    };
    const mk = (signature: string, count: number, sessionIds: string[]): Candidate => ({
      kind: "unknown", signature, examples: [signature], count, sessions: sessionIds.length,
      sessionIds, occurrences: sessionIds.map((sessionId, i) => ({ ts: `2026-06-0${i + 1}T10:00:00Z`, sessionId })),
      memberSignatures: [signature], confidence: "high",
    });
    const bySignature = new Map<string, Candidate>([
      ["approve the pr", mk("approve the pr", 5, ["s1", "s2", "s3", "s4", "s5"])],
      ["approve this pr", mk("approve this pr", 3, ["s5", "s6"])],
    ]);
    const out = mergeNearDuplicates([host, flaggedDup], bySignature);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe("flagged");
    expect(out[0].evidence.count).toBe(8);
    expect(out[0].rationale).toContain("8×");
    expect(out[0].rationale).toContain("6 distinct sessions");
  });
});

describe("idFor", () => {
  it("is stable across ordering and duplicates within the same signature set", () => {
    expect(idFor(["b", "a", "a"], "command")).toBe(idFor(["a", "b"], "command"));
  });

  it("differs by payload type for the same signatures", () => {
    expect(idFor(["a"], "command")).not.toBe(idFor(["a"], "rule"));
  });

  it("differs for a different signature set", () => {
    expect(idFor(["a"], "command")).not.toBe(idFor(["a", "b"], "command"));
  });
});

describe("byLeverage", () => {
  const suggestion = (estMinutesSavedPerMonth: number | undefined, count = 1, name = "x"): Suggestion => ({
    id: name, name, title: "x", rationale: "x", confidence: "high",
    evidence: { count, sessions: 1, ...(estMinutesSavedPerMonth !== undefined ? { estMinutesSavedPerMonth } : {}) },
    payload: { type: "command", commandName: name, body: "x" },
  });

  it("sorts descending by estMinutesSavedPerMonth, treating a missing value as 0", () => {
    const sorted = [suggestion(1), suggestion(undefined), suggestion(5)].sort(byLeverage);
    expect(sorted.map(s => s.evidence.estMinutesSavedPerMonth)).toEqual([5, 1, undefined]);
  });

  it("uses evidence count and then name as deterministic tiebreaks", () => {
    const sorted = [suggestion(5, 2, "z"), suggestion(5, 3, "b"), suggestion(5, 3, "a")].sort(byLeverage);
    expect(sorted.map(item => item.name)).toEqual(["a", "b", "z"]);
  });
});

