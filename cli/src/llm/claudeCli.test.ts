import { describe, it, expect } from "vitest";
import { ClaudeCliBackend } from "./claudeCli.js";

describe("ClaudeCliBackend", () => {
  it("reports available when `claude` is on PATH", async () => {
    const b = new ClaudeCliBackend({ whichFn: async () => "/usr/bin/claude", runFn: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(await b.available()).toBe(true);
  });
  it("reports unavailable when `claude` missing", async () => {
    const b = new ClaudeCliBackend({ whichFn: async () => null, runFn: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(await b.available()).toBe(false);
  });
  it("extracts the .result field from --output-format json", async () => {
    const wrapper = JSON.stringify({ type: "result", result: '{"suggestions":[]}' });
    const b = new ClaudeCliBackend({
      whichFn: async () => "/usr/bin/claude",
      runFn: async () => ({ code: 0, stdout: wrapper, stderr: "" }),
    });
    expect(await b.complete({ system: "sys", prompt: "p" })).toBe('{"suggestions":[]}');
  });
  it("throws when the claude CLI exits nonzero", async () => {
    const b = new ClaudeCliBackend({
      whichFn: async () => "/usr/bin/claude",
      runFn: async () => ({ code: 1, stdout: "", stderr: "boom" }),
    });
    await expect(b.complete({ system: "s", prompt: "p" })).rejects.toThrow("boom");
  });
});
