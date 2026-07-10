import { describe, expect, it } from "vitest";
import { CodexCliBackend } from "./codexCli.js";

describe("CodexCliBackend", () => {
  it("checks whether codex is on PATH", async () => {
    expect(await new CodexCliBackend({ whichFn: async () => process.execPath }).available()).toBe(true);
    expect(await new CodexCliBackend({ whichFn: async () => null }).available()).toBe(false);
  });

  it("uses an ephemeral isolated read-only exec and returns the final stdout", async () => {
    let seen: { cmd: string; args: string[]; input: string; cwd?: string } | undefined;
    const backend = new CodexCliBackend({
      spawnCwd: "/tmp/neutral",
      model: "gpt-5.4-mini",
      whichFn: async () => process.execPath,
      runFn: async (cmd, args, input, opts) => {
        seen = { cmd, args, input, cwd: opts?.cwd };
        return { code: 0, stdout: '{"suggestions":[]}\n', stderr: "progress" };
      },
    });
    expect(await backend.complete({ system: "classifier", prompt: "[]" }))
      .toBe('{"suggestions":[]}');
    expect(seen?.cmd).toBe(process.execPath);
    expect(seen?.args).toEqual(expect.arrayContaining([
      "exec", "--strict-config", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only",
      "--skip-git-repo-check", "--ask-for-approval", "never", "--config", "project_doc_max_bytes=0",
      "--model", "gpt-5.4-mini", "-",
    ]));
    for (const feature of [
      "shell_tool", "unified_exec", "browser_use", "computer_use", "apps",
      "image_generation", "multi_agent", "hooks", "plugins", "code_mode",
      "workspace_dependencies", "goals",
    ]) {
      const index = seen?.args.findIndex((arg, position) => arg === "--disable" && seen?.args[position + 1] === feature) ?? -1;
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(seen?.input).toContain("<SYSTEM_INSTRUCTIONS>\nclassifier");
    expect(seen?.input).toContain("<UNTRUSTED_INPUT>\n[]");
    expect(seen?.cwd).toBe("/tmp/neutral");
  });

  it("surfaces nonzero exits", async () => {
    const backend = new CodexCliBackend({
      whichFn: async () => process.execPath,
      runFn: async () => ({ code: 2, stdout: "", stderr: "auth failed" }),
    });
    await expect(backend.complete({ system: "s", prompt: "p" })).rejects.toThrow(/auth failed/);
  });
});
