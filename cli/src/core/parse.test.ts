import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAssistantFollowedUserLines,
  parseDialogueLines,
  parseFile,
  parseLines,
  parseTranscript,
  parseTranscriptFile,
  parseToolEventLines,
} from "./parse.js";

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
  it("excludes command-tag turns (routed to events by parseTranscript)", () => {
    const command = JSON.stringify({
      type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:00:00Z",
      message: { role: "user", content: "<command-name>/compact</command-name>" },
    });
    expect(parseLines([command, userString]).map(t => t.text)).toEqual(["fix the bug"]);
  });
  it("attributes recorded assistant usage to the preceding user turn, excluding cache reads", () => {
    const usage = JSON.stringify({
      type: "assistant",
      sessionId: "s1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 },
      },
    });
    expect(parseLines([userString, usage])[0]).toMatchObject({
      assistant: "claude-code",
      usageTokens: 15,
    });
  });
});

describe("parseTranscript", () => {
  const commandLine = (command: string) => JSON.stringify({
    type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:00:00Z",
    message: { role: "user", content: `<command-name>${command}</command-name>` },
  });

  it("routes a command-tag turn into events, not turns", () => {
    const parsed = parseTranscript([commandLine("/compact"), userString]);
    expect(parsed.turns.map(t => t.text)).toEqual(["fix the bug"]);
    expect(parsed.events).toEqual([
      { ts: "2026-06-01T00:00:00Z", sessionId: "s1", project: "x", command: "/compact" },
    ]);
  });

  it("keeps a prompt that merely starts with a non-command tag as a turn", () => {
    const line = JSON.stringify({
      type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:00:00Z",
      message: { role: "user", content: "<div>why is this broken?</div>" },
    });
    const parsed = parseTranscript([line]);
    expect(parsed.turns.map(t => t.text)).toEqual(["<div>why is this broken?</div>"]);
    expect(parsed.events).toEqual([]);
  });

  it("trims whitespace inside the captured command name", () => {
    const line = JSON.stringify({
      type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:00:00Z",
      message: { role: "user", content: "<command-name> /ship </command-name>" },
    });
    expect(parseTranscript([line]).events[0].command).toBe("/ship");
  });
});

describe("parseTranscriptFile", () => {
  it("reads a jsonl file from disk and splits turns from command events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-parse-tx-"));
    const file = join(dir, "t.jsonl");
    const prompt = JSON.stringify({
      type: "user", sessionId: "s", cwd: "/p/x", timestamp: "2026-06-01T00:00:00Z",
      message: { role: "user", content: "hello world" },
    });
    const command = JSON.stringify({
      type: "user", sessionId: "s", cwd: "/p/x", timestamp: "2026-06-01T00:01:00Z",
      message: { role: "user", content: "<command-name>/compact</command-name>" },
    });
    await writeFile(file, `${prompt}\n${command}\n`);
    const parsed = await parseTranscriptFile(file);
    expect(parsed.turns.map(t => t.text)).toEqual(["hello world"]);
    expect(parsed.events.map(e => e.command)).toEqual(["/compact"]);
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

  it("recovers explicit answers from structured question results", () => {
    const question = "Which package manager should I use?";
    const lines = [mk({
      type: "user",
      sessionId: "s",
      timestamp: "t2",
      message: { role: "user", content: [{ type: "tool_result", content: "synthetic wrapper" }] },
      toolUseResult: {
        questions: [{ question }],
        answers: { [question]: "pnpm" },
      },
    })];
    expect(parseDialogueLines(lines).map(turn => [turn.role, turn.text])).toEqual([
      ["assistant", question],
      ["user", "pnpm"],
    ]);
  });
});

const toolUse = (id: string, name: string, input: Record<string, unknown>, sessionId = "s1") =>
  JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp: "2026-07-01T00:00:00Z",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });

const toolResult = (id: string, isError: boolean, content: unknown, sessionId = "s1") =>
  JSON.stringify({
    type: "user",
    sessionId,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content }],
    },
  });

describe("parseToolEventLines", () => {
  it("pairs bash tool_use with its result and keeps a redacted error head", () => {
    const { events } = parseToolEventLines([
      toolUse("t1", "Bash", { command: "npm test" }),
      toolResult("t1", true, "FAIL src/x.test.ts\n  expected 1 to be 2"),
    ]);
    expect(events).toEqual([{
      ts: "2026-07-01T00:00:00Z",
      sessionId: "s1",
      kind: "bash",
      command: "npm test",
      isError: true,
      errorHead: "FAIL src/x.test.ts",
    }]);
  });

  it("emits edit events from Edit/Write/NotebookEdit and ignores other tools", () => {
    const { events } = parseToolEventLines([
      toolUse("t1", "Edit", { file_path: "/p/src/a.ts" }),
      toolUse("t2", "Read", { file_path: "/p/src/a.ts" }),
      toolUse("t3", "Write", { file_path: "/p/src/b.ts" }),
      toolUse("t4", "NotebookEdit", { notebook_path: "/p/notebook.ipynb" }),
    ]);
    expect(events.map(event => event.kind)).toEqual(["edit", "edit", "edit"]);
    expect(events.map(event => event.file)).toEqual([
      "/p/src/a.ts",
      "/p/src/b.ts",
      "/p/notebook.ipynb",
    ]);
  });

  it("skips unpaired bash uses and sidechains", () => {
    const sidechainToolUse = JSON.stringify({
      type: "assistant",
      isSidechain: true,
      sessionId: "s1",
      message: {
        content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "ls" } }],
      },
    });
    const { events } = parseToolEventLines([
      toolUse("t1", "Bash", { command: "npm test" }),
      sidechainToolUse,
    ]);
    expect(events).toEqual([]);
  });

  it("collapses multi-line commands to their first line", () => {
    const { events } = parseToolEventLines([
      toolUse("t1", "Bash", { command: "make dev \\\n  EXTRA=1" }),
      toolResult("t1", false, "ok"),
    ]);
    expect(events[0].command).toBe("make dev \\");
  });

  it("bounds command text before retaining the tool event", () => {
    const { events } = parseToolEventLines([
      toolUse("t1", "Bash", { command: "x".repeat(2_000) }),
      toolResult("t1", false, "ok"),
    ]);
    expect(events[0].command).toHaveLength(1_000);
  });

  it("pairs duplicate tool ids only within their session", () => {
    const { events } = parseToolEventLines([
      toolUse("t1", "Bash", { command: "npm test" }, "s1"),
      toolUse("t1", "Bash", { command: "npm run lint" }, "s2"),
      toolResult("t1", false, "ok", "s1"),
      toolResult("t1", true, "lint failed", "s2"),
    ]);
    expect(events.map(event => [event.sessionId, event.command, event.isError])).toEqual([
      ["s1", "npm test", false],
      ["s2", "npm run lint", true],
    ]);
  });

  it("caps each session at 400 events and reports drops", () => {
    const lines: string[] = [];
    for (let index = 0; index < 405; index++) {
      lines.push(
        toolUse(`t${index}`, "Bash", { command: `echo ${index}` }),
        toolResult(`t${index}`, false, "ok"),
      );
    }
    const { events, dropped } = parseToolEventLines(lines);
    expect(events).toHaveLength(400);
    expect(dropped).toBe(5);
    expect(events[0].command).toBe("echo 5");
  });

  it("redacts secrets in string and block-array error heads", () => {
    const { events } = parseToolEventLines([
      toolUse("t1", "Bash", { command: "deploy" }),
      toolResult("t1", true, [{ type: "text", text: "token=sk-ant-api03-abcdef1234567890\ntrace" }]),
    ]);
    expect(events[0].errorHead).not.toContain("sk-ant-");
    expect(events[0].errorHead).toContain("[REDACTED]");
  });
});

describe("parseAssistantFollowedUserLines", () => {
  it("keeps human prompts only after same-session assistant activity", () => {
    const lines = [
      JSON.stringify({
        type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "t0",
        message: { role: "user", content: "first prompt" },
      }),
      JSON.stringify({
        type: "assistant", sessionId: "s1", timestamp: "t1",
        message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Edit" }] },
      }),
      JSON.stringify({
        type: "user", sessionId: "s1", timestamp: "t2",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
      }),
      JSON.stringify({
        type: "user", sessionId: "s2", cwd: "/p/x", timestamp: "t3",
        message: { role: "user", content: "different session" },
      }),
      JSON.stringify({
        type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "t4",
        message: { role: "user", content: "don't edit generated files" },
      }),
      JSON.stringify({
        type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "t5",
        message: { role: "user", content: "second consecutive prompt" },
      }),
    ];
    expect(parseAssistantFollowedUserLines(lines).map(turn => turn.text)).toEqual([
      "don't edit generated files",
    ]);
  });

  it("ignores sidechain assistant activity", () => {
    const lines = [
      JSON.stringify({
        type: "assistant", isSidechain: true, sessionId: "s1",
        message: { role: "assistant", content: "agent activity" },
      }),
      JSON.stringify({
        type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "t1",
        message: { role: "user", content: "no, use pnpm" },
      }),
    ];
    expect(parseAssistantFollowedUserLines(lines)).toEqual([]);
  });
});
