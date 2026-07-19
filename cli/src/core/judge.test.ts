import { describe, it, expect } from "vitest";
import { buildJudgePrompt, parseJudgeResponse, judge, MAX_RESPONSE_CHARS } from "./judge.js";
import type { LLMBackend } from "../llm/backend.js";

const fake = (fn: () => Promise<string>): LLMBackend => ({
  name: "fake", available: async () => true, complete: fn,
});

describe("buildJudgePrompt", () => {
  it("embeds the personal playbook and tail; nudge has no next-step authority", () => {
    const req = buildJudgePrompt("nudge", "PB-CONTENT", "", "TAIL-CONTENT");
    expect(req.prompt).toContain("PB-CONTENT");
    expect(req.prompt).toContain("TAIL-CONTENT");
    expect(req.prompt).not.toContain("PROJECT PLAYBOOK");
    expect(req.system).toContain("stand down");
    expect(req.system).not.toContain("typical next step");
  });

  it("full mode adds next-step authority and requires both playbooks to allow", () => {
    const req = buildJudgePrompt("full", "pb", "proj", "tail");
    expect(req.system).toContain("typical next step");
    expect(req.system).toContain("irreversible");
    expect(req.system).toContain("both playbooks");
  });

  it("renders a provenance-labeled project block only for pinned prose", () => {
    const req = buildJudgePrompt("nudge", "PB-CONTENT", "PROJ-CONTENT", "TAIL-CONTENT");
    expect(req.prompt).toContain("PROJECT PLAYBOOK (this repo):\nPROJ-CONTENT");
    expect(req.prompt.indexOf("PROJECT PLAYBOOK")).toBeLessThan(req.prompt.indexOf("YOUR PLAYBOOK"));
    expect(buildJudgePrompt("nudge", "pb", "   ", "tail").prompt).not.toContain("PROJECT PLAYBOOK");
  });
});

describe("parseJudgeResponse fenced output", () => {
  // Real claude-cli output: the model wraps its JSON in a markdown fence even
  // when told "respond ONLY with JSON". A raw JSON.parse throws, respond fails
  // open, and autopilot silently never fires. Tolerate the fence.
  it("accepts a ```json fenced object", () => {
    const raw = '```json\n{\n  "action": "stand_down",\n  "why": "claude asked a question"\n}\n```';
    expect(parseJudgeResponse(raw)).toEqual({ action: "stand_down", why: "claude asked a question" });
  });

  it("accepts a bare ``` fenced object", () => {
    const raw = '```\n{"action":"continue","response":"keep going","why":"todos open"}\n```';
    expect(parseJudgeResponse(raw)).toEqual({ action: "continue", response: "keep going", why: "todos open" });
  });

  it("accepts surrounding whitespace around a fence", () => {
    const raw = '\n  ```json\n{"action":"stand_down","why":"done"}\n```  \n';
    expect(parseJudgeResponse(raw)).toEqual({ action: "stand_down", why: "done" });
  });

  it("still throws on genuine non-JSON prose", () => {
    expect(() => parseJudgeResponse("I think you should keep going!")).toThrow();
  });

  it("still enforces the action contract inside a fence", () => {
    expect(() => parseJudgeResponse('```json\n{"action":"maybe","why":"x"}\n```')).toThrow(/invalid judge action/);
  });

  it("still requires a response for a fenced continue", () => {
    expect(() => parseJudgeResponse('```json\n{"action":"continue","why":"x"}\n```')).toThrow(/non-empty response/);
  });
});

describe("parseJudgeResponse", () => {
  it("accepts a valid continue", () => {
    expect(parseJudgeResponse('{"action":"continue","response":"keep going","why":"todos open"}'))
      .toEqual({ action: "continue", response: "keep going", why: "todos open" });
  });

  it("accepts a valid stand_down without response", () => {
    expect(parseJudgeResponse('{"action":"stand_down","why":"asked the user"}'))
      .toEqual({ action: "stand_down", why: "asked the user" });
  });

  it.each([
    ["not json", "plain text"],
    ["bad action", '{"action":"restart","why":"w"}'],
    ["continue without response", '{"action":"continue","why":"w"}'],
    ["continue with blank response", '{"action":"continue","response":"  ","why":"w"}'],
    ["oversized response", JSON.stringify({ action: "continue", response: "x".repeat(MAX_RESPONSE_CHARS + 1), why: "w" })],
    ["oversized why", JSON.stringify({ action: "stand_down", why: "y".repeat(501) })],
    ["missing why", '{"action":"stand_down"}'],
    ["non-string why", '{"action":"continue","response":"go","why":42}'],
  ])("throws on %s", (_name, raw) => {
    expect(() => parseJudgeResponse(raw)).toThrow();
  });
});

describe("judge", () => {
  it("returns the parsed decision from the backend", async () => {
    const d = await judge(fake(async () => '{"action":"stand_down","why":"done"}'), { system: "s", prompt: "p" });
    expect(d.action).toBe("stand_down");
  });

  it("throws when the backend exceeds the timeout", async () => {
    let aborted = false;
    const never: LLMBackend = {
      name: "fake",
      available: async () => true,
      complete: req => new Promise<string>((_resolve, reject) => {
        req.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      }),
    };
    await expect(judge(never, { system: "s", prompt: "p" }, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    expect(aborted).toBe(true);
  });

  it("propagates backend errors (caller fails open)", async () => {
    const boom = fake(async () => { throw new Error("cli exploded"); });
    await expect(judge(boom, { system: "s", prompt: "p" })).rejects.toThrow("cli exploded");
  });
});
