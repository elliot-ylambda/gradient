import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLines, parseFile, parseDialogueLines } from "./parse.js";

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

describe("parseFile", () => {
  it("reads a jsonl file from disk and returns user turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-parse-"));
    const file = join(dir, "t.jsonl");
    const line = JSON.stringify({
      type: "user", sessionId: "s", cwd: "/p/x",
      timestamp: "2026-06-01T00:00:00Z",
      message: { role: "user", content: "hello world" },
    });
    await writeFile(file, line + "\r\n"); // CRLF on purpose — exercises the split fix
    const turns = await parseFile(file);
    expect(turns.map(t => t.text)).toEqual(["hello world"]);
  });
});

describe("parseDialogueLines", () => {
  const mk = (value: object) => JSON.stringify(value);

  it("yields assistant text turns alongside user turns, in order", () => {
    const lines = [
      mk({ type: "user", sessionId: "s", timestamp: "t1", cwd: "/p", message: { role: "user", content: "hi" } }),
      mk({ type: "assistant", sessionId: "s", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "Which db?" }, { type: "tool_use", name: "Bash" }] } }),
      mk({ type: "user", sessionId: "s", timestamp: "t3", cwd: "/p", message: { role: "user", content: "postgres" } }),
    ];
    const out = parseDialogueLines(lines);
    expect(out.map(turn => [turn.role, turn.text])).toEqual([
      ["user", "hi"],
      ["assistant", "Which db?"],
      ["user", "postgres"],
    ]);
  });

  it("skips sidechains and tool-only assistant turns", () => {
    const lines = [
      mk({ type: "assistant", isSidechain: true, sessionId: "s", message: { role: "assistant", content: [{ type: "text", text: "side" }] } }),
      mk({ type: "assistant", sessionId: "s", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } }),
    ];
    expect(parseDialogueLines(lines)).toEqual([]);
  });
});
