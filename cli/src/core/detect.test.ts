import { describe, it, expect } from "vitest";
import { detect, candidateToCommand } from "./detect.js";
import type { Candidate } from "./types.js";

const cand = (signature: string, count: number, confidence: any = "high"): Candidate =>
  ({ kind: "unknown", signature, examples: [signature], count, sessions: count, confidence });

describe("candidateToCommand", () => {
  it("derives a slash-command suggestion from a high-confidence candidate", () => {
    const s = candidateToCommand(cand("merge main into this pr", 9));
    expect(s.payload.type).toBe("command");
    if (s.payload.type === "command") expect(s.payload.commandName).toBe("merge-main-into");
    expect(s.confidence).toBe("high");
  });
});

describe("detect", () => {
  it("degrades to command suggestions when llm is null", async () => {
    const out = await detect([cand("merge main into this pr", 9), cand("fuzzy thing", 4, "inferred")], null);
    // only high-confidence becomes a suggestion without an LLM
    expect(out.length).toBe(1);
    expect(out[0].payload.type).toBe("command");
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
    const c: Candidate = { kind: "unknown", signature: "deploy with token sk-ant-abc123def", examples: ["deploy with token sk-ant-abc123def"], count: 5, sessions: 3, confidence: "high" };
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
});
