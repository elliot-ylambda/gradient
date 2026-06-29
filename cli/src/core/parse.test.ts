import { describe, it, expect } from "vitest";
import { parseLines } from "./parse.js";

const userString = JSON.stringify({
  type: "user", isSidechain: false, sessionId: "s1", cwd: "/p/x",
  timestamp: "2026-06-01T00:00:00Z", gitBranch: "main",
  message: { role: "user", content: "fix the bug" },
});
const userArray = JSON.stringify({
  type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:01:00Z",
  message: { role: "user", content: [
    { type: "text", text: "do the thing" },
    { type: "tool_result", content: "ignored" },
  ] },
});
const toolResultOnly = JSON.stringify({
  type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:02:00Z",
  message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
});
const sidechain = JSON.stringify({
  type: "user", isSidechain: true, sessionId: "s1", cwd: "/p/x",
  timestamp: "2026-06-01T00:03:00Z", message: { role: "user", content: "agent prompt" },
});
const assistant = JSON.stringify({
  type: "assistant", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:04:00Z",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
});

describe("parseLines", () => {
  it("extracts user string and text-array prompts", () => {
    const turns = parseLines([userString, userArray]);
    const texts = turns.map(t => t.text);
    expect(texts).toEqual(["fix the bug", "do the thing"]);
  });
  it("drops tool-result-only user turns, sidechains, and assistant turns", () => {
    const turns = parseLines([toolResultOnly, sidechain, assistant]);
    expect(turns.length).toBe(0);
  });
  it("skips malformed lines without throwing", () => {
    const turns = parseLines(["not json", "", userString]);
    expect(turns.length).toBe(1);
  });
});
