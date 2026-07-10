import { describe, it, expect } from "vitest";
import { selectBackend, defaultCandidates } from "./index.js";
import { ClaudeCliBackend } from "./claudeCli.js";

const avail = (name: string, ok: boolean) =>
  ({ name, available: async () => ok, complete: async () => "" });

describe("selectBackend", () => {
  it("prefers claude-cli when available", async () => {
    const b = await selectBackend({ candidates: [avail("claude-cli", true), avail("anthropic", true)] });
    expect(b?.name).toBe("claude-cli");
  });
  it("falls back to anthropic when claude-cli unavailable", async () => {
    const b = await selectBackend({ candidates: [avail("claude-cli", false), avail("anthropic", true)] });
    expect(b?.name).toBe("anthropic");
  });
  it("returns null when none available", async () => {
    const b = await selectBackend({ candidates: [avail("claude-cli", false), avail("anthropic", false)] });
    expect(b).toBeNull();
  });
  it("honors an explicit config.backend when that backend is available", async () => {
    const b = await selectBackend({
      candidates: [avail("claude-cli", true), avail("anthropic", true)],
      config: { backend: "anthropic" },
    });
    expect(b?.name).toBe("anthropic");
  });
  it("fails closed when an explicit backend is unavailable", async () => {
    const b = await selectBackend({
      candidates: [avail("claude-cli", true), avail("anthropic", false)],
      config: { backend: "anthropic" },
    });
    expect(b).toBeNull();
  });
});

describe("defaultCandidates", () => {
  it("carries the autopilot recursion guard on the default claude-cli backend", () => {
    const candidates = defaultCandidates();
    const cli = candidates[0];
    expect(cli).toBeInstanceOf(ClaudeCliBackend);
    const extraEnv = (cli as unknown as { extraEnv?: Record<string, string> }).extraEnv;
    expect(extraEnv).toEqual({ GRADIENT_AUTOPILOT_CHILD: "1" });
  });
});

describe("scan's claude child runs outside the project", () => {
  // Without a neutral spawnCwd, `claude -p "<candidates JSON>"` runs inside the
  // project, so Claude Code records a transcript for that headless session in
  // the project's transcript dir — and the NEXT scan mines gradient's own prompt
  // back as if the user had typed it. Measured: candidate-JSON turns surviving
  // into the mined corpus. respond already guards this way; scan must too.
  it("defaultCandidates lets the backend create a private per-call cwd", async () => {
    const cli = defaultCandidates()[0] as { name: string; spawnCwd?: string };
    expect(cli.name).toBe("claude-cli");
    expect(cli.spawnCwd).toBeUndefined();
  });
});
