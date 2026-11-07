import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { join as pjoin } from "node:path";
import { autopilotBackend, respond, type RespondDeps, type StopHookInput } from "./respond.js";
import { loadState, saveState, freshState } from "../core/state.js";
import type { LLMBackend } from "../llm/backend.js";
import type { Config } from "../core/types.js";
import { projectKey } from "../config.js";
import { CodexCliBackend } from "../llm/codexCli.js";

const tmpHome = () => mkdtemp(join(tmpdir(), "grad-home-"));

const fakeBackend = (reply: string): LLMBackend => ({
  name: "fake", available: async () => true, complete: async () => reply,
});

const CONTINUE = '{"action":"continue","response":"continue until actually done","why":"open todos"}';
const STAND_DOWN = '{"action":"stand_down","why":"claude asked the user a question"}';

// Transcript with N tool_use blocks (fingerprint = tools:N) after the assistant's text
const transcript = (tools: number, text = "working"): string[] => [
  JSON.stringify({ type: "user", message: { content: "do the thing" } }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }, ...Array.from({ length: tools }, () => ({ type: "tool_use", name: "Edit" }))] },
  }),
];

const input: StopHookInput = { session_id: "sess1", transcript_path: "t.jsonl", cwd: "/nonexistent-repo" };
const consent = (cwd: string, mode: "nudge" | "full" | "off" = "nudge", extra: Partial<Config> = {}): Config => ({
  ...extra,
  autopilotProjects: { [projectKey(cwd)]: mode },
});

async function run(over: Partial<RespondDeps> & { home: string; tools?: number }) {
  const deps: RespondDeps = {
    config: consent(input.cwd!),
    backend: fakeBackend(CONTINUE),
    readLines: async () => transcript(over.tools ?? 3),
    env: {},
    now: () => "2026-07-01T00:00:00Z",
    ...over,
  };
  return respond(input, deps);
}

describe("respond gates (all fail-open)", () => {
  it("gate 1: recursion guard env → allow, no state touched", async () => {
    const home = await tmpHome();
    const r = await run({ home, env: { GRADIENT_AUTOPILOT_CHILD: "1" } });
    expect(r.decision).toBe("allow");
    expect((await loadState("sess1", home)).count).toBe(0);
  });

  it("gate 2: mode off or absent → allow", async () => {
    const home = await tmpHome();
    expect((await run({ home, config: {} as Config })).decision).toBe("allow");
    expect((await run({ home, config: consent(input.cwd!, "off") })).decision).toBe("allow");
  });

  it("missing session_id or transcript_path → allow", async () => {
    const home = await tmpHome();
    const r = await respond({}, { home, config: consent(input.cwd!), env: {} });
    expect(r.decision).toBe("allow");
  });

  it("missing cwd → allow (clamp can't be checked, so no action)", async () => {
    const home = await tmpHome();
    const r = await respond({ session_id: "s", transcript_path: "t" },
      { home, config: consent(input.cwd!), backend: fakeBackend(CONTINUE), readLines: async () => transcript(3), env: {} });
    expect(r.decision).toBe("allow");
  });

  it("gate 3: budget exhausted → allow without calling the judge", async () => {
    const home = await tmpHome();
    await saveState("sess1", { ...freshState(), attempts: 10 }, home);
    let called = false;
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async () => { called = true; return CONTINUE; } };
    const r = await run({ home, backend });
    expect(r.decision).toBe("allow");
    expect(called).toBe(false);
  });

  it("gate 4: unchanged fingerprint after a response → stands down and latches", async () => {
    const home = await tmpHome();
    await saveState("sess1", { ...freshState(), count: 1, lastFingerprint: "tools:3" }, home);
    const r = await run({ home, tools: 3 }); // no new tool activity
    expect(r.decision).toBe("allow");
    expect((await loadState("sess1", home)).stoodDown).toBe(true);
  });

  it("stood-down latch clears when tool activity advances", async () => {
    const home = await tmpHome();
    await saveState("sess1", { ...freshState(), count: 1, lastFingerprint: "tools:3", stoodDown: true }, home);
    const r = await run({ home, tools: 5 }); // progress since latch
    expect(r.decision).toBe("block");
    expect((await loadState("sess1", home)).stoodDown).toBe(false);
  });
});

describe("respond judge outcomes", () => {
  it("honors an explicitly selected Codex judge backend", async () => {
    const home = await tmpHome();
    const available = vi.spyOn(CodexCliBackend.prototype, "available").mockResolvedValue(true);
    const complete = vi.spyOn(CodexCliBackend.prototype, "complete").mockResolvedValue(CONTINUE);
    try {
      const result = await run({ home, backend: undefined, config: consent(input.cwd!, "nudge", { backend: "codex-cli" }) });
      expect(result).toEqual({ decision: "block", reason: "Continue." });
      expect(available).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      available.mockRestore();
      complete.mockRestore();
    }
  });

  /** Transcript tails reach a different provider only when the user pinned it. */
  it("never falls back to Codex when no backend is pinned", async () => {
    const home = await tmpHome();
    const available = vi.spyOn(CodexCliBackend.prototype, "available").mockResolvedValue(true);
    const complete = vi.spyOn(CodexCliBackend.prototype, "complete").mockResolvedValue(CONTINUE);
    try {
      const backend = await autopilotBackend({ autopilotProjects: {} });
      expect(backend?.name).not.toBe("codex-cli");
      expect((await autopilotBackend({ backend: "codex-cli" }))?.name).toBe("codex-cli");
    } finally {
      available.mockRestore();
      complete.mockRestore();
    }
  });

  it("does not invoke a judge from leftover Claude hooks when targets are Codex-only", async () => {
    const home = await tmpHome();
    const complete = vi.fn(async () => CONTINUE);
    const result = await run({ home, config: consent(input.cwd!, "nudge", { targets: ["codex"] }), backend: { name: "fake", available: async () => true, complete } });
    expect(result.decision).toBe("allow");
    expect(complete).not.toHaveBeenCalled();
  });
  it("continue → block with a fixed trusted nudge, state updated & logged", async () => {
    const home = await tmpHome();
    const r = await run({ home });
    expect(r).toEqual({ decision: "block", reason: "Continue." });
    const s = await loadState("sess1", home);
    expect(s.count).toBe(1);
    expect(s.attempts).toBe(1);
    expect(s.lastFingerprint).toBe("tools:3");
    expect(s.log[0]).toMatchObject({ action: "continue", why: "open todos", ts: "2026-07-01T00:00:00Z" });
  });

  /** What Claude Code writes when a request fails: a synthetic assistant message. */
  const apiError = (error: string) => JSON.stringify({
    type: "assistant", isApiErrorMessage: true, error,
    message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: The response stopped arriving. The response above may be incomplete." }] },
  });

  it("a cut-off response gets \"Continue.\" without asking the judge", async () => {
    const home = await tmpHome();
    const complete = vi.fn(async () => STAND_DOWN);
    const lines = [...transcript(1, "Refactoring the parser now."), apiError("server_error")];
    const r = await run({ home, backend: { name: "fake", available: async () => true, complete }, readLines: async () => lines });
    expect(r).toEqual({ decision: "block", reason: "Continue." });
    expect(complete).not.toHaveBeenCalled();
    const s = await loadState("sess1", home);
    // The judge-free nudge still spends budget and records progress, so it cannot loop.
    expect(s).toMatchObject({ attempts: 1, count: 1, lastFingerprint: "tools:1" });
    expect(s.log[0]).toMatchObject({ action: "continue", why: "the response was cut off" });
  });

  it("reads an interruption only from Claude Code's marker, never from a model's own words", async () => {
    const home = await tmpHome();
    const complete = vi.fn(async () => STAND_DOWN);
    const lines = transcript(1, "API Error: The response stopped arriving. That is what the log says; shall I dig in?");
    expect(await run({ home, backend: { name: "fake", available: async () => true, complete }, readLines: async () => lines }))
      .toEqual({ decision: "allow" });
    expect(complete).toHaveBeenCalled();
  });

  it("does not answer a rate limit with an instant retry", async () => {
    const home = await tmpHome();
    const lines = [...transcript(1, "Refactoring the parser now."), apiError("rate_limit")];
    expect(await run({ home, backend: fakeBackend(STAND_DOWN), readLines: async () => lines }))
      .toEqual({ decision: "allow" });
  });

  it.each([
    "Fixed and tests pass. Next I'll push the branch and deploy to production.",
    "I pushed the fix.",
    "Sending it to the team now.",
  ])("stays out when the last message names a step the user decides: %s", async text => {
    const home = await tmpHome();
    const complete = vi.fn(async () => CONTINUE);
    const r = await run({ home, backend: { name: "fake", available: async () => true, complete }, readLines: async () => transcript(1, text) });
    expect(r).toEqual({ decision: "allow" });
    expect(complete).not.toHaveBeenCalled();
    expect((await loadState("sess1", home)).log[0]).toMatchObject({ action: "stand_down", why: "the last message names a step the user decides" });
  });

  it.each(["Parsed the JSON payload.", "Added a Postgres index and wired the PostToolUse hook.", "Fixed the dropdown."])(
    "does not mistake an ordinary word for a decision: %s", async text => {
      const home = await tmpHome();
      const complete = vi.fn(async () => STAND_DOWN);
      await run({ home, backend: { name: "fake", available: async () => true, complete }, readLines: async () => transcript(1, text) });
      expect(complete).toHaveBeenCalled();
    });

  it.each([
    ["server_error", "block"],
    ["overloaded_error", "block"],
    ["authentication_failed", "allow"],
    ["something_new", "allow"],
  ] as const)("retries only failures a retry can fix: %s → %s", async (kind, decision) => {
    const home = await tmpHome();
    const lines = [...transcript(1, "Refactoring the parser now."), apiError(kind)];
    const r = await run({ home, backend: fakeBackend(STAND_DOWN), readLines: async () => lines });
    expect(r.decision).toBe(decision);
  });

  it("keeps a turn cut off mid-deploy stopped: the veto runs before the retry", async () => {
    const home = await tmpHome();
    const lines = [...transcript(1, "Deploying the gateway to production now."), apiError("server_error")];
    expect(await run({ home, readLines: async () => lines })).toEqual({ decision: "allow" });
  });

  it("checks the whole last message, not just its end", async () => {
    const home = await tmpHome();
    const complete = vi.fn(async () => CONTINUE);
    const text = `I will merge the branch once you agree. ${"Details of the change follow. ".repeat(40)}`;
    expect(await run({ home, backend: { name: "fake", available: async () => true, complete }, readLines: async () => transcript(1, text) }))
      .toEqual({ decision: "allow" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("stand_down → allow, logged, count unchanged", async () => {
    const home = await tmpHome();
    const r = await run({ home, backend: fakeBackend(STAND_DOWN) });
    expect(r.decision).toBe("allow");
    const s = await loadState("sess1", home);
    expect(s.count).toBe(0);
    expect(s.attempts).toBe(1);
    expect(s.log[0].action).toBe("stand_down");
  });

  it.each([
    ["malformed judge output", fakeBackend("not json")],
    ["backend throws", { name: "f", available: async () => true, complete: async () => { throw new Error("boom"); } } as LLMBackend],
  ])("%s → allow (fail-open)", async (_n, backend) => {
    const home = await tmpHome();
    expect((await run({ home, backend })).decision).toBe("allow");
    expect((await loadState("sess1", home)).attempts).toBe(1);
  });

  it("no backend available → allow", async () => {
    const home = await tmpHome();
    expect((await run({ home, backend: null })).decision).toBe("allow");
  });

  it("unreadable transcript → allow", async () => {
    const home = await tmpHome();
    const r = await run({ home, readLines: async () => { throw new Error("ENOENT"); } });
    expect(r.decision).toBe("allow");
  });

  it("redacts secrets from the tail before the judge sees it", async () => {
    const home = await tmpHome();
    let seen = "";
    const backend: LLMBackend = {
      name: "f", available: async () => true,
      complete: async req => { seen = req.prompt; return STAND_DOWN; },
    };
    const lines = [JSON.stringify({ type: "user", message: { content: "use API_KEY=supersecret123 now" } })];
    await run({ home, backend, readLines: async () => lines });
    expect(seen).toContain("[REDACTED]");
    expect(seen).not.toContain("supersecret123");
  });
});

// helper: a temp repo dir containing a gradient.md
async function repoWith(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-repo-"));
  await writeFile(pjoin(dir, "gradient.md"), contents);
  return dir;
}

describe("respond project clamp", () => {
  it("project max-mode: off → allow without calling the judge", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  max-mode: off\n---\n## Rules\n");
    let called = false;
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async () => { called = true; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: consent(cwd), backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("allow");
    expect(called).toBe(false);
  });

  it("malformed project frontmatter → allow (clamped off), judge not called", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  max-mode: turbo\n---\n");
    let called = false;
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async () => { called = true; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: consent(cwd), backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("allow");
    expect(called).toBe(false);
  });

  it("project budget clamps below config: budget:0 → allow, judge not called", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  budget: 0\n---\n");
    let called = false;
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async () => { called = true; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: consent(cwd, "nudge", { autopilotBudget: 10 }), backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("allow");
    expect(called).toBe(false);
  });

  it("unpinned repository prose never reaches the judge prompt or emitted nudge", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  max-mode: full\n---\n## Rules\n- SENTINEL-PROSE\n");
    let seenPrompt = "";
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async (req) => { seenPrompt = req.prompt; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: consent(cwd), backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("block");
    expect(seenPrompt).not.toContain("SENTINEL-PROSE");
    expect(r).toEqual({ decision: "block", reason: "Continue." });
  });

  it("pinned repository prose reaches the judge with its provenance label", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  max-mode: nudge\n---\n## Rules\n- SENTINEL-PROSE\n");
    const { parseProjectPlaybook, savePlaybookPin } = await import("../core/playbook.js");
    // Pin the exact prose the file will parse to (body after the frontmatter block).
    const prose = parseProjectPlaybook("---\nautopilot:\n  max-mode: nudge\n---\n## Rules\n- SENTINEL-PROSE\n").prose;
    await savePlaybookPin(cwd, prose, home);
    let seenPrompt = "";
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async (req) => { seenPrompt = req.prompt; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: consent(cwd), backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("block");
    expect(seenPrompt).toContain("PROJECT PLAYBOOK (this repo):");
    expect(seenPrompt).toContain("SENTINEL-PROSE");
    expect(r).toEqual({ decision: "block", reason: "Continue." });
  });

  it("legacy full consent fails closed without calling the judge", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  max-mode: nudge\n---\n");
    let called = false;
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async () => { called = true; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: consent(cwd, "full"), backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("allow");
    expect(called).toBe(false);
  });

  it("no project file → behaves exactly as before (nudge continues)", async () => {
    const home = await tmpHome();
    const cwd = await mkdtemp(join(tmpdir(), "grad-empty-"));
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: consent(cwd), backend: fakeBackend(CONTINUE), readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("block");
  });
});
