import { describe, expect, it } from "vitest";
import { selectBackend, defaultCandidates } from "./index.js";
import { ClaudeCliBackend } from "./claudeCli.js";
import { CodexCliBackend } from "./codexCli.js";

const avail = (name: string, ok: boolean) =>
  ({ name, available: async () => ok, complete: async () => "" });

describe("selectBackend", () => {
  it("prefers the first available backend", async () => {
    expect((await selectBackend({ candidates: [avail("claude-cli", true), avail("anthropic", true)] }))?.name)
      .toBe("claude-cli");
    expect((await selectBackend({ candidates: [avail("claude-cli", false), avail("anthropic", true)] }))?.name)
      .toBe("anthropic");
  });

  it("returns null when none are available", async () => {
    expect(await selectBackend({ candidates: [avail("claude-cli", false)] })).toBeNull();
  });

  it("honors available Anthropic and Codex provider pins", async () => {
    expect((await selectBackend({
      candidates: [avail("claude-cli", true), avail("anthropic", true)],
      config: { backend: "anthropic" },
    }))?.name).toBe("anthropic");
    expect((await selectBackend({
      candidates: [avail("claude-cli", true), avail("codex-cli", true)],
      config: { backend: "codex-cli", targets: ["codex"] },
    }))?.name).toBe("codex-cli");
  });

  it("fails closed when an explicitly pinned backend is unavailable", async () => {
    expect(await selectBackend({
      candidates: [avail("claude-cli", true), avail("anthropic", false)],
      config: { backend: "anthropic" },
    })).toBeNull();
    expect(await selectBackend({
      candidates: [avail("claude-cli", true)],
      config: { backend: "codex-cli" },
    })).toBeNull();
  });
});

describe("defaultCandidates", () => {
  it("carries the recursion guard and uses private per-call cwd creation", () => {
    const claude = defaultCandidates()[0] as ClaudeCliBackend & { extraEnv?: Record<string, string> };
    expect(claude).toBeInstanceOf(ClaudeCliBackend);
    expect((claude as unknown as { extraEnv?: Record<string, string> }).extraEnv)
      .toEqual({ GRADIENT_AUTOPILOT_CHILD: "1" });
    expect(claude.spawnCwd).toBeUndefined();
  });

  it("prefers Codex for Codex-only targets and lets it create a private cwd", () => {
    const codex = defaultCandidates({ targets: ["codex"] })[0] as CodexCliBackend;
    expect(codex).toBeInstanceOf(CodexCliBackend);
    expect(codex.spawnCwd).toBeUndefined();
    expect(defaultCandidates({ targets: ["claude-code", "codex"] })[1]).toBeInstanceOf(CodexCliBackend);
  });
});
