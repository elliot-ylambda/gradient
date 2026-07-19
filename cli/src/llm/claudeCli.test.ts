import { describe, it, expect } from "vitest";
import { ClaudeCliBackend } from "./claudeCli.js";

describe("ClaudeCliBackend", () => {
  it("reports available when `claude` is on PATH", async () => {
    const b = new ClaudeCliBackend({ whichFn: async () => process.execPath, runFn: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(await b.available()).toBe(true);
  });
  it("reports unavailable when `claude` missing", async () => {
    const b = new ClaudeCliBackend({ whichFn: async () => null, runFn: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(await b.available()).toBe(false);
  });
  it("extracts the .result field from --output-format json", async () => {
    const wrapper = JSON.stringify({ type: "result", result: '{"suggestions":[]}' });
    const b = new ClaudeCliBackend({
      whichFn: async () => process.execPath,
      runFn: async () => ({ code: 0, stdout: wrapper, stderr: "" }),
    });
    expect(await b.complete({ system: "sys", prompt: "p" })).toBe('{"suggestions":[]}');
  });
  it("throws when the claude CLI exits nonzero", async () => {
    const b = new ClaudeCliBackend({
      whichFn: async () => process.execPath,
      runFn: async () => ({ code: 1, stdout: "", stderr: "boom" }),
    });
    await expect(b.complete({ system: "s", prompt: "p" })).rejects.toThrow("boom");
  });
});

describe("spawn options", () => {
  it("threads spawnCwd and extraEnv through to the run function", async () => {
    let captured: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
    const backend = new ClaudeCliBackend({
      whichFn: async () => process.execPath,
      runFn: async (_cmd, _args, _input, opts) => {
        captured = opts;
        return { code: 0, stdout: JSON.stringify({ result: "ok" }), stderr: "" };
      },
      spawnCwd: "/tmp/neutral",
      extraEnv: { GRADIENT_AUTOPILOT_CHILD: "1" },
    });
    await backend.complete({ system: "s", prompt: "p" });
    expect(captured?.cwd).toBe("/tmp/neutral");
    expect(captured?.env?.GRADIENT_AUTOPILOT_CHILD).toBe("1");
    expect(captured?.env?.PATH).toBe(process.env.PATH); // parent env preserved
  });

  it("passes no env override when extraEnv is not set", async () => {
    let captured: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
    const backend = new ClaudeCliBackend({
      whichFn: async () => process.execPath,
      runFn: async (_cmd, _args, _input, opts) => {
        captured = opts;
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    await backend.complete({ system: "s", prompt: "p" });
    expect(captured?.env).toBeUndefined();
  });
});

describe("system prompt mode", () => {
  const capture = async (system: string) => {
    let seen: string[] = [];
    const b = new ClaudeCliBackend({
      whichFn: async () => process.execPath,
      runFn: async (_cmd, args) => { seen = args; return { code: 0, stdout: '{"result":"{}"}', stderr: "" }; },
    });
    await b.complete({ system, prompt: "p" });
    return seen;
  };

  it("replaces the default system prompt rather than appending to it", async () => {
    // --append-system-prompt leaves Claude Code's coding-agent framing in place:
    // the child notices its spawnCwd is a temp dir and answers in prose instead
    // of the JSON contract. Replacing it makes the call a pure LLM judge.
    const args = await capture("JUDGE INSTRUCTIONS");
    expect(args).toContain("--system-prompt");
    expect(args).not.toContain("--append-system-prompt");
  });

  it("still passes the system text as the flag's value", async () => {
    const args = await capture("JUDGE INSTRUCTIONS");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("JUDGE INSTRUCTIONS");
  });
});

describe("the child is isolated from tools and user customizations", () => {
  const capture = async () => {
    let seen: string[] = [];
    let input = "";
    const b = new ClaudeCliBackend({
      whichFn: async () => process.execPath,
      runFn: async (_cmd, args, stdin) => {
        seen = args;
        input = stdin;
        return { code: 0, stdout: '{"result":"{}"}', stderr: "" };
      },
    });
    await b.complete({ system: "s", prompt: "private prompt" });
    return { args: seen, input };
  };

  it("uses fail-closed isolation flags and disables every built-in tool", async () => {
    const { args } = await capture();
    for (const flag of ["--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome", "--no-session-persistence"]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("sends private prompt text over stdin, never argv", async () => {
    const { args, input } = await capture();
    expect(args).not.toContain("private prompt");
    expect(input).toBe("private prompt");
  });
});
