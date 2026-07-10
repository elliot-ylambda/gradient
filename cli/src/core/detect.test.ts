import { describe, it, expect } from "vitest";
import { detect, candidateToCommand, buildDetectPrompt, candidateRef } from "./detect.js";
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

  it("redacts secrets and PII before sending candidates", () => {
    const source = cand("email person@example.com token sk-ant-abc123def", 3);
    const { prompt } = buildDetectPrompt([source]);
    expect(prompt).not.toContain("person@example.com");
    expect(prompt).not.toContain("sk-ant-abc123def");
    expect(prompt).toContain("[REDACTED");
  });
});

describe("detect", () => {
  it("degrades only high-confidence non-answer candidates", async () => {
    const answer: Candidate = { ...cand("pnpm ← Which package manager do you prefer?", 3, "inferred"), kind: "answer" };
    const out = await detect([cand("merge main", 9), cand("fuzzy", 4, "inferred"), answer], null);
    expect(out).toHaveLength(1);
    expect(out[0].payload.type).toBe("command");
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

  it("degrades safely when the backend throws or returns malformed JSON", async () => {
    const source = cand(`deploy with npm_${"a".repeat(36)}`, 5);
    const boom = { name: "boom", available: async () => true, complete: async () => { throw new Error("nope"); } };
    const [out] = await detect([source], boom);
    expect(JSON.stringify(out)).not.toContain("npm_aaaa");
    expect(JSON.stringify(out)).toContain("[REDACTED]");

    const malformed = { name: "bad", available: async () => true, complete: async () => "not json" };
    expect(await detect([source], malformed)).toHaveLength(1);
  });
});
