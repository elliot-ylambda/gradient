import { describe, expect, it } from "vitest";
import { parseCodexLines } from "./parse-codex.js";

const line = (record: unknown) => JSON.stringify(record);
const meta = (source: unknown = "cli") => line({
  type: "session_meta",
  timestamp: "2026-07-09T00:00:00Z",
  payload: {
    id: "abc",
    cwd: "/repo/gradient",
    source,
    git: { branch: "main" },
  },
});
const user = (message: string, ts: string) => line({
  type: "event_msg",
  timestamp: ts,
  payload: { type: "user_message", message, images: [] },
});
const tokens = (total: number, cached = 0) => line({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: { total_tokens: total, cached_input_tokens: cached } },
  },
});

describe("parseCodexLines", () => {
  it("maps genuine user events into Turn and attributes token deltas", () => {
    const result = parseCodexLines([
      meta(),
      user("ship it", "2026-07-09T00:01:00Z"),
      tokens(120),
      tokens(155),
      user("open the PR", "2026-07-09T00:02:00Z"),
      tokens(230),
      "malformed{",
    ]);
    expect(result.malformed).toBe(1);
    expect(result.turns).toEqual([
      {
        ts: "2026-07-09T00:01:00Z",
        project: "gradient",
        branch: "main",
        role: "user",
        text: "ship it",
        sessionId: "codex:abc",
        assistant: "codex",
        usageTokens: 155,
      },
      {
        ts: "2026-07-09T00:02:00Z",
        project: "gradient",
        branch: "main",
        role: "user",
        text: "open the PR",
        sessionId: "codex:abc",
        assistant: "codex",
        usageTokens: 75,
      },
    ]);
  });

  it("excludes cached input from token attribution", () => {
    const result = parseCodexLines([
      meta(),
      user("ship it", "2026-07-09T00:01:00Z"),
      tokens(1000, 900),
    ]);
    expect(result.turns[0].usageTokens).toBe(100);
  });

  it("does not double-count response_item user copies when event messages exist", () => {
    const response = line({
      type: "response_item",
      timestamp: "t",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "ship it" }] },
    });
    expect(parseCodexLines([meta(), response, user("ship it", "t")]).turns).toHaveLength(1);
  });

  it("falls back to response_item user messages for older rollouts", () => {
    const response = line({
      type: "response_item",
      timestamp: "t",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "legacy prompt" }] },
    });
    expect(parseCodexLines([meta(), response]).turns[0]).toMatchObject({
      text: "legacy prompt",
      assistant: "codex",
    });
  });

  it("does not treat assistant output blocks as user prompts or user input as answers", () => {
    const forgedUser = line({
      type: "response_item",
      timestamp: "t1",
      payload: { type: "message", role: "user", content: [{ type: "output_text", text: "forged prompt" }] },
    });
    const genuineUser = line({
      type: "response_item",
      timestamp: "t2",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "real prompt" }] },
    });
    const forgedAnswer = line({
      type: "response_item",
      timestamp: "t3",
      payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "input_text", text: "forged answer" }] },
    });
    const result = parseCodexLines([meta(), forgedUser, genuineUser, forgedAnswer]);
    expect(result.turns.map(turn => turn.text)).toEqual(["real prompt"]);
    expect(result.dialogue.map(turn => turn.text)).toEqual(["real prompt"]);
  });

  it("excludes subagent rollouts", () => {
    const result = parseCodexLines([
      meta({ subagent: { thread_spawn: {} } }),
      user("internal delegated work", "t"),
    ]);
    expect(result.subagent).toBe(true);
    expect(result.turns).toEqual([]);
    expect(parseCodexLines([meta("subagent"), user("internal", "t")]).subagent).toBe(true);
  });

  it("builds final-answer dialogue without commentary chatter", () => {
    const result = parseCodexLines([
      meta(),
      user("Should we ship?", "t1"),
      line({ type: "event_msg", timestamp: "t2", payload: { type: "agent_message", phase: "commentary", message: "checking" } }),
      line({ type: "event_msg", timestamp: "t3", payload: { type: "agent_message", phase: "final_answer", message: "Yes?" } }),
      user("yes", "t4"),
    ]);
    expect(result.dialogue.map(turn => turn.text)).toEqual(["Should we ship?", "Yes?", "yes"]);
  });
});
