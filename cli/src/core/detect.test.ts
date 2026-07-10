import { describe, it, expect } from "vitest";
import { detect, candidateToCommand, buildDetectPrompt, sanitizeClarify } from "./detect.js";
import type { Candidate } from "./types.js";

const cand = (signature: string, count: number, confidence: any = "high"): Candidate =>
  ({ kind: "unknown", signature, examples: [signature], count, sessions: count, sessionIds: ["s"], confidence });

describe("candidateToCommand", () => {
  it("derives a reusable command suggestion from a high-confidence candidate", () => {
    const s = candidateToCommand(cand("merge main into this pr", 9));
    expect(s.payload.type).toBe("command");
    if (s.payload.type === "command") expect(s.payload.commandName).toBe("merge-main-into");
    expect(s.confidence).toBe("high");
  });

  it("seeds degraded command triggers from the candidate signature", () => {
    const s = candidateToCommand(cand("lgtm", 5));
    expect(s.payload).toMatchObject({ type: "command", triggers: ["lgtm"] });
  });

  it("redacts a signature everywhere in degraded suggestions", () => {
    const suggestion = candidateToCommand(cand("ANTHROPIC_API_KEY=sk-ant-abc123 make dev", 3));
    expect(JSON.stringify(suggestion)).not.toContain("sk-ant-abc123");
    expect(JSON.stringify(suggestion)).toContain("[REDACTED]");
  });

  it("keeps degraded sequence steps ordered and triggers only on the first step", () => {
    const sequence: Candidate = {
      ...cand("review the spec → write the plan", 3),
      kind: "sequence",
      examples: ["review the spec ⏎ write the plan"],
    };
    const suggestion = candidateToCommand(sequence);
    expect(suggestion.payload).toMatchObject({
      type: "command",
      triggers: ["review the spec"],
      body: "1. review the spec\n2. write the plan",
    });
  });
});

describe("buildDetectPrompt", () => {
  it("asks the model for command triggers and explains that commands emit as skills", () => {
    const { system } = buildDetectPrompt([]);
    expect(system).toContain("triggers");
    expect(system).toContain("skill");
    expect(system).toContain("every merged cluster's signature");
  });

  it("asks for clarify options on ambiguous flagged suggestions", () => {
    const { system } = buildDetectPrompt([]);
    expect(system).toContain("clarify");
    expect(system).toContain("flagged");
  });

  it("describes paste and answer kinds and the rule payload", () => {
    const { system } = buildDetectPrompt([]);
    expect(system).toContain("'paste'");
    expect(system).toContain("'answer'");
    expect(system).toContain("type:'rule'");
  });

  it("includes candidate kind in prompt JSON", () => {
    const { prompt } = buildDetectPrompt([{
      kind: "paste",
      signature: "make dev",
      examples: [],
      count: 3,
      sessions: 3,
      sessionIds: [],
      confidence: "high",
    }]);
    expect(JSON.parse(prompt)[0].kind).toBe("paste");
  });
});

describe("sanitizeClarify", () => {
  const good = {
    question: "Acknowledge or merge?",
    options: [
      { label: "acknowledge", body: "Treat as sign-off only." },
      { label: "merge", body: "Approve and merge once checks pass." },
    ],
  };

  it("passes a valid 2-option clarify through", () => {
    expect(sanitizeClarify(good)).toEqual(good);
  });

  it("accepts 3 options, rejects 1 and 4", () => {
    const opt = good.options[0];
    expect(sanitizeClarify({ ...good, options: [opt, opt, opt] })).toBeDefined();
    expect(sanitizeClarify({ ...good, options: [opt] })).toBeUndefined();
    expect(sanitizeClarify({ ...good, options: [opt, opt, opt, opt] })).toBeUndefined();
  });

  it("rejects non-string fields and missing pieces", () => {
    expect(sanitizeClarify(undefined)).toBeUndefined();
    expect(sanitizeClarify({ question: 1, options: good.options })).toBeUndefined();
    expect(sanitizeClarify({ question: "q", options: [{ label: "a", body: 2 }, good.options[0]] })).toBeUndefined();
    expect(sanitizeClarify({ question: "q" })).toBeUndefined();
  });

  it("strips unknown keys from options and never trusts a chosen value from the model", () => {
    const noisy = {
      question: "q",
      chosen: "a",
      options: [
        { label: "a", body: "b", extra: true },
        { label: "c", body: "d" },
      ],
    };
    expect(sanitizeClarify(noisy)).toEqual({
      question: "q",
      options: [
        { label: "a", body: "b" },
        { label: "c", body: "d" },
      ],
    });
  });
});

describe("detect", () => {
  it("degrades to command suggestions when llm is null", async () => {
    const out = await detect([cand("merge main into this pr", 9), cand("fuzzy thing", 4, "inferred")], null);
    // only high-confidence becomes a suggestion without an LLM
    expect(out.length).toBe(1);
    expect(out[0].payload.type).toBe("command");
  });

  it("turns paste candidates into self-service fixes and drops answer candidates without an LLM", async () => {
    const paste: Candidate = {
      ...cand("make dev", 3),
      kind: "paste",
      examples: ["pasted output of: make dev"],
    };
    const answer: Candidate = { ...cand("1 ← Which approach?", 3, "inferred"), kind: "answer" };
    const out = await detect([paste, answer], null);
    expect(out).toHaveLength(1);
    expect(out[0].payload).toMatchObject({ type: "command" });
    if (out[0].payload.type === "command") {
      expect(out[0].payload.body).toContain("Run `make dev` yourself");
      expect(out[0].payload.body).toContain("Do not ask the user to paste output");
    }
  });

  it("uses the llm result when available and traces evidence by sourceSignature", async () => {
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async () => JSON.stringify({
        suggestions: [{
          sourceSignature: "push and create a pr",
          name: "ship", title: "Ship", rationale: "r", confidence: "high",
          payload: { type: "command", commandName: "ship", body: "push and open a PR" },
        }],
      }),
    };
    const out = await detect([cand("push and create a pr", 13)], llm);
    expect(out[0].name).toBe("ship");
    expect(out[0].evidence.count).toBe(13);
  });

  it("redacts secrets in candidate examples before sending to the llm", async () => {
    let seenPrompt = "";
    const llm = {
      name: "fake", available: async () => true,
      complete: async (req: any) => { seenPrompt = req.prompt; return JSON.stringify({ suggestions: [] }); },
    };
    const c: Candidate = { kind: "unknown", signature: "deploy with token sk-ant-abc123def", examples: ["deploy with token sk-ant-abc123def"], count: 5, sessions: 3, sessionIds: ["s1", "s2", "s3"], confidence: "high" };
    await detect([c], llm);
    expect(seenPrompt).not.toContain("sk-ant-abc123def");
    expect(seenPrompt).toContain("[REDACTED]");
  });

  it("caps candidates and reports the drop", async () => {
    let dropped = -1;
    const many = Array.from({ length: 20 }, (_, i) => cand(`p${i}`, 20 - i));
    const llm = { name: "f", available: async () => true, complete: async () => JSON.stringify({ suggestions: [] }) };
    await detect(many, llm, { limit: 5, onCap: d => (dropped = d) });
    expect(dropped).toBe(15);
  });

  it("reports zero evidence (not the top candidate's) when sourceSignature doesn't match", async () => {
    const llm = {
      name: "fake", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceSignature: "does-not-exist",
        name: "ghost", title: "Ghost", rationale: "r", confidence: "high",
        payload: { type: "command", commandName: "ghost", body: "x" },
      }] }),
    };
    const out = await detect([cand("real signature here", 13)], llm);
    expect(out[0].name).toBe("ghost");
    expect(out[0].evidence.count).toBe(0);
    expect(out[0].evidence.sessions).toBe(0);
  });

  it("degrades to high-confidence commands when the backend throws", async () => {
    const llm = { name: "boom", available: async () => true,
      complete: async () => { throw new Error("claude exited 1"); } };
    const out = await detect([cand("merge main into this pr", 9)], llm);
    expect(out.length).toBe(1);
    expect(out[0].payload.type).toBe("command");
  });

  it("filters out a JSON suggestion that has no payload", async () => {
    const llm = { name: "f", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{ name: "x", title: "t", rationale: "r", confidence: "high" }] }) };
    const out = await detect([cand("something", 5)], llm);
    expect(out.length).toBe(0); // no crash, malformed suggestion dropped
  });

  it("normalizes an out-of-set confidence to 'inferred' instead of dropping the suggestion", async () => {
    const llm = { name: "f", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceSignature: "x", name: "keep-me", title: "t", rationale: "r", confidence: "medium",
        payload: { type: "command", commandName: "keep-me", body: "do it" },
      }] }) };
    const out = await detect([cand("x", 5)], llm);
    expect(out.length).toBe(1);
    expect(out[0].confidence).toBe("inferred");
  });

  it("keeps only a valid clarify from an ambiguous flagged suggestion", async () => {
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [
        {
          sourceSignature: "lgtm",
          name: "approve",
          title: "Approve",
          rationale: "ambiguous intent",
          confidence: "flagged",
          clarify: {
            question: "Acknowledge or merge?",
            chosen: "merge",
            options: [
              { label: "acknowledge", body: "Treat as sign-off only.", ignored: true },
              { label: "merge", body: "Approve and merge once checks pass." },
            ],
          },
          payload: { type: "command", commandName: "approve", body: "ambiguous" },
        },
        {
          sourceSignature: "ship",
          name: "ship",
          title: "Ship",
          rationale: "clear intent",
          confidence: "high",
          clarify: {
            question: "Should not survive",
            options: [
              { label: "a", body: "a" },
              { label: "b", body: "b" },
            ],
          },
          payload: { type: "command", commandName: "ship", body: "ship" },
        },
        {
          sourceSignature: "review",
          name: "review",
          title: "Review",
          rationale: "bad clarify",
          confidence: "flagged",
          clarify: { question: "Only one?", options: [{ label: "a", body: "a" }] },
          payload: { type: "command", commandName: "review", body: "review" },
        },
      ] }),
    };
    const out = await detect([cand("lgtm", 5), cand("ship", 5), cand("review", 5)], llm);
    expect(out[0].clarify).toEqual({
      question: "Acknowledge or merge?",
      options: [
        { label: "acknowledge", body: "Treat as sign-off only." },
        { label: "merge", body: "Approve and merge once checks pass." },
      ],
    });
    expect(out[1].clarify).toBeUndefined();
    expect(out[2].clarify).toBeUndefined();
  });

  it("merges synonymous clusters, summing counts and unioning sessions", async () => {
    const a: Candidate = { kind: "unknown", signature: "lgtm", examples: ["lgtm"], count: 5, sessions: 2, sessionIds: ["s1", "s2"], confidence: "high" };
    const b: Candidate = { kind: "unknown", signature: "looks good", examples: ["looks good"], count: 3, sessions: 2, sessionIds: ["s2", "s3"], confidence: "inferred" };
    const llm = {
      name: "fake", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceSignatures: ["lgtm", "looks good"],
        name: "approve", title: "Approve", rationale: "r", confidence: "high",
        payload: { type: "command", commandName: "approve", body: "lgtm" },
      }] }),
    };
    const out = await detect([a, b], llm);
    expect(out.length).toBe(1);
    expect(out[0].evidence.count).toBe(8);        // 5 + 3
    expect(out[0].evidence.sessions).toBe(3);     // union {s1,s2,s3}
  });

  it("populates redacted examples on a suggestion for explain", async () => {
    const llm = {
      name: "fake", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceSignatures: ["deploy with token sk-ant-abc123def"],
        name: "deploy", title: "Deploy", rationale: "r", confidence: "high",
        payload: { type: "command", commandName: "deploy", body: "deploy" },
      }] }),
    };
    const c: Candidate = { kind: "unknown", signature: "deploy with token sk-ant-abc123def", examples: ["deploy with token sk-ant-abc123def"], count: 4, sessions: 1, sessionIds: ["s1"], confidence: "high" };
    const out = await detect([c], llm);
    expect(out[0].examples?.[0]).toContain("[REDACTED]");
    expect(out[0].examples?.[0]).not.toContain("sk-ant-abc123def");
  });
});

it("briefs the model on sequence candidates and forwards their kind", () => {
  const seq = { kind: "sequence" as const, signature: "review the spec → write the plan",
    examples: ["review the spec ⏎ write the plan"], count: 5, sessions: 3,
    sessionIds: ["a", "b", "c"], confidence: "high" as const };
  const { system, prompt } = buildDetectPrompt([seq]);
  expect(system).toContain("sequence");
  expect(system).toContain("numbered");
  expect(JSON.parse(prompt)[0].kind).toBe("sequence");
});

it("omits kind for unknown candidates (prompt stays unchanged for them)", () => {
  const c = { kind: "unknown" as const, signature: "lgtm", examples: ["lgtm"],
    count: 5, sessions: 3, sessionIds: ["a"], confidence: "high" as const };
  expect(JSON.parse(buildDetectPrompt([c]).prompt)[0].kind).toBeUndefined();
});

it("briefs the model to flag only zero-judgment mechanical workflows", () => {
  const { system } = buildDetectPrompt([]);
  expect(system).toContain("mechanical:true");
  expect(system).toContain("zero judgment");
  expect(system).toContain("review a spec");
});
