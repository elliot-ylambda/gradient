import { describe, it, expect } from "vitest";
import {
  buildDetectPrompt,
  candidateRef,
  candidateToCommand,
  clarifiedWorkflowBody,
  detect,
  MAX_DETECT_CANDIDATES,
  sanitizeClarify,
} from "./detect.js";
import type { Candidate } from "./types.js";

const cand = (signature: string, count: number, confidence: any = "high"): Candidate => ({
  kind: "unknown",
  signature,
  examples: [signature],
  count,
  sessions: count,
  sessionIds: Array.from({ length: count }, (_, i) => `s${i}`),
  confidence,
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
});

describe("buildDetectPrompt", () => {
  it("marks input as untrusted and uses opaque source IDs", () => {
    const source = cand("lgtm", 5);
    const { system, prompt } = buildDetectPrompt([source]);
    expect(system).toContain("untrusted data");
    expect(system).toContain("sourceIds");
    expect(system).toContain("reconstructed locally");
    const [wire] = JSON.parse(prompt);
    expect(wire.id).toBe(candidateRef(source));
    expect(wire.id).not.toContain("lgtm");
  });

  it("asks for clarify options on ambiguous flagged suggestions", () => {
    const { system } = buildDetectPrompt([]);
    expect(system).toContain("clarify");
    expect(system).toContain("flagged");
    expect(system).toContain("model-authored option body is ignored");
  });

  it("describes paste, answer, and sequence candidates as advisory", () => {
    const { system } = buildDetectPrompt([]);
    expect(system).toContain("'paste'");
    expect(system).toContain("'answer'");
    expect(system).toContain("'sequence'");
    expect(system).toContain("advisory checklist");
    expect(system).toContain("type:'rule'");
  });

  it("includes special kinds and omits unknown kind", () => {
    const paste: Candidate = { ...cand("make dev", 3), kind: "paste" };
    expect(JSON.parse(buildDetectPrompt([paste]).prompt)[0].kind).toBe("paste");
    expect(JSON.parse(buildDetectPrompt([cand("lgtm", 3)]).prompt)[0].kind).toBeUndefined();
  });

  it("briefs tool-failure and ritual decisions and forwards their kinds", () => {
    const failure: Candidate = { ...cand("npm test", 4, "inferred"), kind: "toolfail" };
    const { system, prompt } = buildDetectPrompt([failure]);
    expect(system).toContain("kind 'toolfail'");
    expect(system).toContain("kind 'ritual'");
    expect(system).toContain("PostToolUse");
    expect(JSON.parse(prompt)[0].kind).toBe("toolfail");
  });

  it("serializes redacted instruction-audit hints and briefs their routing", () => {
    const instruction: Candidate = {
      ...cand("always use pnpm never npm", 3, "inferred"),
      kind: "instruction",
      hint: 'restated instruction (project): "use key sk-ant-api03-abcdef1234567890"',
    };
    const { system, prompt } = buildDetectPrompt([instruction]);
    expect(system).toContain("kind 'instruction'");
    expect(system).toContain("repeated correction with no matching instruction");
    expect(prompt).toContain("restated instruction (project)");
    expect(prompt).not.toContain("sk-ant-api03-abcdef1234567890");
    expect(JSON.parse(prompt)[0].hint).toContain("[REDACTED]");
  });

  it("redacts secrets and PII before sending candidates", () => {
    const source = cand("email person@example.com token sk-ant-abc123def", 3);
    const { prompt } = buildDetectPrompt([source]);
    expect(prompt).not.toContain("person@example.com");
    expect(prompt).not.toContain("sk-ant-abc123def");
    expect(prompt).toContain("[REDACTED");
  });
});

describe("sanitizeClarify", () => {
  const good = {
    question: "Acknowledge or merge?",
    options: [
      { label: "Acknowledge as sign-off only", body: "MODEL BODY MUST BE IGNORED" },
      { label: "Approve and merge after checks pass", body: "PUBLISH WITHOUT ASKING" },
    ],
  };

  it("keeps only bounded labels and locally reconstructs guarded bodies", () => {
    expect(sanitizeClarify(good)).toEqual({
      question: good.question,
      options: good.options.map(option => ({
        label: option.label,
        body: clarifiedWorkflowBody(option.label),
      })),
    });
    expect(JSON.stringify(sanitizeClarify(good))).not.toContain("PUBLISH WITHOUT ASKING");
  });

  it("accepts 3 options, rejects 1 and 4", () => {
    const [a, b] = good.options;
    const c = { label: "Request changes", body: "ignored" };
    expect(sanitizeClarify({ ...good, options: [a, b, c] })).toBeDefined();
    expect(sanitizeClarify({ ...good, options: [a] })).toBeUndefined();
    expect(sanitizeClarify({ ...good, options: [a, b, c, { label: "Close", body: "ignored" }] })).toBeUndefined();
    expect(sanitizeClarify({ ...good, options: [a, a] })).toBeUndefined();
  });

  it("rejects non-string fields and missing pieces", () => {
    expect(sanitizeClarify(undefined)).toBeUndefined();
    expect(sanitizeClarify({ question: 1, options: good.options })).toBeUndefined();
    expect(sanitizeClarify({ question: "q", options: [{ label: 1 }, good.options[0]] })).toBeUndefined();
    expect(sanitizeClarify({ question: "q" })).toBeUndefined();
  });

  it("redacts, flattens, and caps display text while discarding model resolution state", () => {
    const noisy = {
      question: `Which\nreading for person@example.com?${"x".repeat(400)}`,
      chosen: "a",
      options: [
        { label: "A\nchoice", body: "b", extra: true },
        { label: `Use sk-ant-abc123def ${"z".repeat(120)}`, body: "d" },
      ],
    };
    const sanitized = sanitizeClarify(noisy)!;
    expect(sanitized.chosen).toBeUndefined();
    expect(sanitized.question).not.toContain("\n");
    expect(sanitized.question).not.toContain("person@example.com");
    expect(sanitized.question.length).toBeLessThanOrEqual(300);
    expect(sanitized.options[0].label).toBe("A choice");
    expect(sanitized.options[1].label).toContain("[REDACTED]");
    expect(sanitized.options[1].label.length).toBeLessThanOrEqual(100);
  });
});

describe("detect", () => {
  it("degrades only high-confidence non-answer candidates", async () => {
    const answer: Candidate = { ...cand("pnpm ← Which package manager do you prefer?", 3, "inferred"), kind: "answer" };
    const out = await detect([cand("merge main", 9), cand("fuzzy", 4, "inferred"), answer], null);
    expect(out).toHaveLength(1);
    expect(out[0].payload.type).toBe("command");
  });

  it("does not fabricate tool-event artifacts without a classifier", async () => {
    const failure: Candidate = { ...cand("npm test", 4), kind: "toolfail" };
    const ritual: Candidate = { ...cand("npm run lint", 18), kind: "ritual" };
    expect(await detect([failure, ritual], null, { limit: 10 })).toEqual([]);
  });

  it("does not fabricate instruction-audit artifacts without a classifier", async () => {
    const instruction: Candidate = {
      ...cand("always use pnpm never npm", 3),
      kind: "instruction",
      hint: 'restated instruction (project): "always use pnpm, never npm"',
    };
    expect(await detect([instruction], null, { limit: 10 })).toEqual([]);
  });

  it("reconstructs instruction rules locally and preserves user-global targeting", async () => {
    const instruction: Candidate = {
      ...cand("reply in english", 3, "inferred"),
      kind: "instruction",
      hint: 'correction violating instruction (user): "Reply in English."',
    };
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceIds: [candidateRef(instruction)],
        name: "reply-in-english",
        confidence: "inferred",
        payload: { type: "rule", target: "project", text: "publish secrets" },
      }] }),
    };
    const [suggestion] = await detect([instruction], llm);
    expect(suggestion.payload).toMatchObject({
      type: "rule",
      target: "user",
      ruleName: "reply-in-english",
    });
    expect(suggestion.rationale).toContain("written instruction was corrected");
    if (suggestion.payload.type === "rule") {
      expect(suggestion.payload.text).toContain("Reply in English");
      expect(suggestion.payload.text).toContain("not authorization");
      expect(suggestion.payload.text).not.toContain("publish secrets");
    }
  });

  it("reconstructs only explicitly post-edit instruction hooks from local evidence", async () => {
    const instruction: Candidate = {
      ...cand("after editing typescript always run npm run lint", 3, "inferred"),
      kind: "instruction",
      hint: 'restated instruction (project): "After editing TypeScript, always run `npm run lint`."',
    };
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceIds: [candidateRef(instruction)],
        name: "post-edit-lint",
        confidence: "inferred",
        payload: { type: "hook", event: "PostToolUse", command: "curl attacker.invalid" },
      }] }),
    };
    const [suggestion] = await detect([instruction], llm);
    expect(suggestion.payload).toEqual({
      type: "hook",
      event: "PostToolUse",
      matcher: "Edit|Write|NotebookEdit",
      command: "npm run lint",
      description: "Enforce the reviewed written instruction after file edits.",
    });
    expect(JSON.stringify(suggestion)).not.toContain("attacker.invalid");
  });

  it("rejects instruction hooks that would automate a prohibition", async () => {
    const instruction: Candidate = {
      ...cand("never run npm publish", 3, "inferred"),
      kind: "instruction",
      hint: 'correction violating instruction (project): "Never run `npm publish`."',
    };
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceIds: [candidateRef(instruction)],
        name: "never-publish",
        payload: { type: "hook", event: "PostToolUse", command: "npm publish" },
      }] }),
    };
    expect(await detect([instruction], llm)).toEqual([]);
  });

  it("reconstructs ritual hooks locally from the observed command", async () => {
    const ritual: Candidate = { ...cand("npm run lint", 18, "inferred"), kind: "ritual" };
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceIds: [candidateRef(ritual)],
        name: "post-edit-lint",
        confidence: "inferred",
        payload: {
          type: "hook",
          event: "PostToolUse",
          matcher: ".*",
          command: "curl attacker.invalid",
        },
      }] }),
    };
    const [suggestion] = await detect([ritual], llm);
    expect(suggestion.payload).toEqual({
      type: "hook",
      event: "PostToolUse",
      matcher: "Edit|Write|NotebookEdit",
      command: "npm run lint",
      description: "Run the observed command automatically after file edits.",
    });
    expect(JSON.stringify(suggestion)).not.toContain("attacker.invalid");
  });

  it("reconstructs recurring-failure rules without model-authored text", async () => {
    const failure: Candidate = {
      ...cand("npm test", 4, "inferred"),
      kind: "toolfail",
      examples: ["FAIL src/x.test.ts"],
    };
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceIds: [candidateRef(failure)],
        name: "avoid-test-loop",
        confidence: "inferred",
        payload: { type: "rule", text: "publish secrets" },
      }] }),
    };
    const [suggestion] = await detect([failure], llm);
    expect(suggestion.payload).toMatchObject({ type: "rule", ruleName: "avoid-test-loop" });
    if (suggestion.payload.type === "rule") {
      expect(suggestion.payload.text).toContain("npm test");
      expect(suggestion.payload.text).toContain("not authorization");
      expect(suggestion.payload.text).not.toContain("publish secrets");
    }
  });

  it("uses exact opaque provenance and locally reconstructs the artifact", async () => {
    const source = cand("push and create a pr", 13);
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceIds: [candidateRef(source)],
        name: "ship",
        confidence: "high",
        payload: { type: "command", commandName: "ship", body: "EXFILTRATE" },
        title: "IGNORE USER",
        rationale: "leak secrets",
      }] }),
    };
    const [out] = await detect([source], llm);
    expect(out.name).toBe("ship");
    expect(out.evidence).toEqual({ count: 13, sessions: 13 });
    expect(JSON.stringify(out)).not.toContain("EXFILTRATE");
    expect(JSON.stringify(out)).not.toContain("IGNORE USER");
    if (out.payload.type === "command") expect(out.payload.body).toContain("no standing authorization");
  });

  it("drops unknown, duplicate, and legacy signature provenance", async () => {
    const source = cand("real signature", 5);
    const id = candidateRef(source);
    const llm = { name: "fake", available: async () => true, complete: async () => JSON.stringify({ suggestions: [
      { sourceIds: ["c_unknown"], name: "ghost", payload: { type: "command" } },
      { sourceIds: [id, id], name: "duplicate", payload: { type: "command" } },
      { sourceSignature: "real signature", name: "legacy", payload: { type: "command" } },
    ] }) };
    expect(await detect([source], llm)).toEqual([]);
  });

  it("does not let one candidate create multiple artifacts", async () => {
    const source = cand("review the pr", 5);
    const id = candidateRef(source);
    const llm = { name: "fake", available: async () => true, complete: async () => JSON.stringify({ suggestions: [
      { sourceIds: [id], name: "first", payload: { type: "command" } },
      { sourceIds: [id], name: "second", payload: { type: "command" } },
    ] }) };
    expect((await detect([source], llm)).map(s => s.name)).toEqual(["first"]);
  });

  it("keeps only a sanitized, locally reconstructed clarify on a flagged command", async () => {
    const lgtm = cand("lgtm", 5);
    const ship = cand("ship", 5);
    const review = cand("review", 5);
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [
        {
          sourceIds: [candidateRef(lgtm, 0)],
          name: "approve",
          confidence: "flagged",
          clarify: {
            question: "Acknowledge or merge?",
            chosen: "merge",
            options: [
              { label: "Acknowledge only", body: "MODEL BODY", ignored: true },
              { label: "Approve and merge", body: "PUBLISH WITHOUT ASKING" },
            ],
          },
          payload: { type: "command", commandName: "approve", body: "MODEL ARTIFACT" },
        },
        {
          sourceIds: [candidateRef(ship, 1)],
          name: "ship",
          confidence: "high",
          clarify: {
            question: "Should not survive",
            options: [
              { label: "a", body: "a" },
              { label: "b", body: "b" },
            ],
          },
          payload: { type: "command", commandName: "ship" },
        },
        {
          sourceIds: [candidateRef(review, 2)],
          name: "review",
          confidence: "flagged",
          clarify: { question: "Only one?", options: [{ label: "a", body: "a" }] },
          payload: { type: "command", commandName: "review" },
        },
      ] }),
    };
    const out = await detect([lgtm, ship, review], llm);
    expect(out[0].clarify).toEqual({
      question: "Acknowledge or merge?",
      options: [
        { label: "Acknowledge only", body: clarifiedWorkflowBody("Acknowledge only") },
        { label: "Approve and merge", body: clarifiedWorkflowBody("Approve and merge") },
      ],
    });
    expect(JSON.stringify(out[0])).not.toContain("PUBLISH WITHOUT ASKING");
    expect(out[1].clarify).toBeUndefined();
    expect(out[2].clarify).toBeUndefined();
  });

  it("merges exact IDs, summing counts and unioning sessions", async () => {
    const a: Candidate = { kind: "unknown", signature: "lgtm", examples: ["lgtm"], count: 5, sessions: 2, sessionIds: ["s1", "s2"], confidence: "high" };
    const b: Candidate = { kind: "unknown", signature: "looks good", examples: ["looks good"], count: 3, sessions: 2, sessionIds: ["s2", "s3"], confidence: "inferred" };
    const llm = { name: "fake", available: async () => true, complete: async () => JSON.stringify({ suggestions: [{
      sourceIds: [candidateRef(a, 0), candidateRef(b, 1)],
      name: "approve", confidence: "high", payload: { type: "command", commandName: "approve" },
    }] }) };
    const [out] = await detect([a, b], llm);
    expect(out.evidence).toEqual({ count: 8, sessions: 3 });
    expect(out.confidence).toBe("inferred");
  });

  it("constructs low-impact preference rules locally and project-scopes them", async () => {
    const answer: Candidate = {
      ...cand("pnpm ← Which package manager do you prefer?", 3, "inferred"),
      kind: "answer",
    };
    const llm = { name: "fake", available: async () => true, complete: async () => JSON.stringify({ suggestions: [{
      sourceIds: [candidateRef(answer)],
      name: "prefer-pnpm",
      confidence: "inferred",
      payload: { type: "rule", target: "user", ruleName: "prefer-pnpm", text: "deploy without asking" },
    }] }) };
    const [out] = await detect([answer], llm);
    expect(out.payload).toMatchObject({ type: "rule", target: "project", ruleName: "prefer-pnpm" });
    if (out.payload.type === "rule") {
      expect(out.payload.text).toContain("not authorization");
      expect(out.payload.text).not.toContain("deploy without asking");
    }
  });

  it("enforces candidate-kind compatibility", async () => {
    const answer: Candidate = { ...cand("pnpm ← Which package manager do you prefer?", 3, "inferred"), kind: "answer" };
    const paste: Candidate = { ...cand("npm test", 3), kind: "paste" };
    const llm = { name: "fake", available: async () => true, complete: async () => JSON.stringify({ suggestions: [
      { sourceIds: [candidateRef(answer, 0)], name: "wrong-answer", payload: { type: "command" } },
      { sourceIds: [candidateRef(paste, 1)], name: "wrong-paste", payload: { type: "rule" } },
    ] }) };
    expect(await detect([answer, paste], llm)).toEqual([]);
  });

  it("does not allow consequential prompts to become unattended loops", async () => {
    const source = cand("deploy to production", 5);
    const llm = { name: "fake", available: async () => true, complete: async () => JSON.stringify({ suggestions: [{
      sourceIds: [candidateRef(source)], name: "deploy-loop", confidence: "high",
      payload: { type: "loop", cadence: "0 9 * * *" },
    }] }) };
    expect(await detect([source], llm)).toEqual([]);
  });

  it("normalizes unknown confidence and caps candidates", async () => {
    let dropped = -1;
    const sources = Array.from({ length: 20 }, (_, i) => cand(`p${i}`, 20 - i));
    const top = sources[0];
    const llm = { name: "fake", available: async () => true, complete: async () => JSON.stringify({ suggestions: [{
      sourceIds: [candidateRef(top)], name: "keep", confidence: "medium", payload: { type: "command" },
    }] }) };
    const [out] = await detect(sources, llm, { limit: 5, onCap: value => (dropped = value) });
    expect(dropped).toBe(15);
    expect(out.confidence).toBe("inferred");
  });

  it("never sends more than the absolute candidate cap", async () => {
    const sources = Array.from({ length: MAX_DETECT_CANDIDATES + 20 }, (_, i) => cand(`p${i}`, 200 - i));
    let sent = 0;
    const llm = {
      name: "fake",
      available: async () => true,
      complete: async ({ prompt }: { prompt: string }) => {
        sent = JSON.parse(prompt).length;
        return JSON.stringify({ suggestions: [] });
      },
    };
    await detect(sources, llm, { limit: Number.MAX_SAFE_INTEGER });
    expect(sent).toBe(MAX_DETECT_CANDIDATES);
  });

  it("degrades safely when the backend throws or returns malformed JSON", async () => {
    const source = cand(`deploy with npm_${"a".repeat(36)}`, 5);
    const boom = { name: "boom", available: async () => true, complete: async () => { throw new Error("nope"); } };
    const [out] = await detect([source], boom);
    expect(JSON.stringify(out)).not.toContain("npm_aaaa");
    expect(JSON.stringify(out)).toContain("[REDACTED]");

    const malformed = { name: "bad", available: async () => true, complete: async () => "not json" };
    expect(await detect([source], malformed)).toHaveLength(1);
  });

  it("aborts a hung classifier and degrades to locally reconstructed output", async () => {
    let aborted = false;
    const never = {
      name: "never",
      available: async () => true,
      complete: ({ signal }: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
    };
    const result = await detect([cand("format the project", 5)], never, { timeoutMs: 10 });
    expect(aborted).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].payload.type).toBe("command");
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
