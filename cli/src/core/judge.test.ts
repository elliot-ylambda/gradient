import { describe, it, expect } from "vitest";
import { buildJudgePrompt, parseJudgeResponse, judge, MAX_RESPONSE_CHARS } from "./judge.js";
import type { LLMBackend } from "../llm/backend.js";

const fake = (fn: () => Promise<string>): LLMBackend => ({
  name: "fake", available: async () => true, complete: fn,
});

describe("buildJudgePrompt", () => {
  it("embeds playbook and tail; nudge mode has no next-step authority", () => {
    const req = buildJudgePrompt("nudge", "PB-CONTENT", "TAIL-CONTENT");
    expect(req.prompt).toContain("PB-CONTENT");
    expect(req.prompt).toContain("TAIL-CONTENT");
    expect(req.system).toContain("stand down");
    expect(req.system).not.toContain("typical next step");
  });

  it("full mode adds next-step authority and the irreversible-actions rule", () => {
    const req = buildJudgePrompt("full", "pb", "tail");
    expect(req.system).toContain("typical next step");
    expect(req.system).toContain("irreversible");
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
    const never = fake(() => new Promise<string>(() => {}));
    await expect(judge(never, { system: "s", prompt: "p" }, { timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });

  it("propagates backend errors (caller fails open)", async () => {
    const boom = fake(async () => { throw new Error("cli exploded"); });
    await expect(judge(boom, { system: "s", prompt: "p" })).rejects.toThrow("cli exploded");
  });
});
