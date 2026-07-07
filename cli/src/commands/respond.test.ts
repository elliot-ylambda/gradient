import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { join as pjoin } from "node:path";
import { respond, type RespondDeps, type StopHookInput } from "./respond.js";
import { loadState, saveState, freshState } from "../core/state.js";
import type { LLMBackend } from "../llm/backend.js";
import type { Config } from "../core/types.js";

const tmpHome = () => mkdtemp(join(tmpdir(), "grad-home-"));

const fakeBackend = (reply: string): LLMBackend => ({
  name: "fake", available: async () => true, complete: async () => reply,
});

const CONTINUE = '{"action":"continue","response":"continue until actually done","why":"open todos"}';
const STAND_DOWN = '{"action":"stand_down","why":"claude asked the user a question"}';

// Transcript with N tool_use blocks (fingerprint = tools:N)
const transcript = (tools: number): string[] => [
  JSON.stringify({ type: "user", message: { content: "do the thing" } }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "working" }, ...Array.from({ length: tools }, () => ({ type: "tool_use", name: "Edit" }))] },
  }),
];

const input: StopHookInput = { session_id: "sess1", transcript_path: "t.jsonl", cwd: "/nonexistent-repo" };

async function run(over: Partial<RespondDeps> & { home: string; tools?: number }) {
  const deps: RespondDeps = {
    config: { autopilot: "nudge" } as Config,
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
    expect((await run({ home, config: { autopilot: "off" } as Config })).decision).toBe("allow");
  });

  it("missing session_id or transcript_path → allow", async () => {
    const home = await tmpHome();
    const r = await respond({}, { home, config: { autopilot: "nudge" } as Config, env: {} });
    expect(r.decision).toBe("allow");
  });

  it("missing cwd → allow (clamp can't be checked, so no action)", async () => {
    const home = await tmpHome();
    const r = await respond({ session_id: "s", transcript_path: "t" },
      { home, config: { autopilot: "nudge" } as Config, backend: fakeBackend(CONTINUE), readLines: async () => transcript(3), env: {} });
    expect(r.decision).toBe("allow");
  });

  it("gate 3: budget exhausted → allow without calling the judge", async () => {
    const home = await tmpHome();
    await saveState("sess1", { ...freshState(), count: 10 }, home);
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
  it("continue → block with the judge's response, state updated & logged", async () => {
    const home = await tmpHome();
    const r = await run({ home });
    expect(r).toEqual({ decision: "block", reason: "continue until actually done" });
    const s = await loadState("sess1", home);
    expect(s.count).toBe(1);
    expect(s.lastFingerprint).toBe("tools:3");
    expect(s.log[0]).toMatchObject({ action: "continue", why: "open todos", ts: "2026-07-01T00:00:00Z" });
  });

  it("stand_down → allow, logged, count unchanged", async () => {
    const home = await tmpHome();
    const r = await run({ home, backend: fakeBackend(STAND_DOWN) });
    expect(r.decision).toBe("allow");
    const s = await loadState("sess1", home);
    expect(s.count).toBe(0);
    expect(s.log[0].action).toBe("stand_down");
  });

  it.each([
    ["malformed judge output", fakeBackend("not json")],
    ["backend throws", { name: "f", available: async () => true, complete: async () => { throw new Error("boom"); } } as LLMBackend],
  ])("%s → allow (fail-open)", async (_n, backend) => {
    const home = await tmpHome();
    expect((await run({ home, backend })).decision).toBe("allow");
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
      { home, config: { autopilot: "full" } as Config, backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("allow");
    expect(called).toBe(false);
  });

  it("malformed project frontmatter → allow (clamped off), judge not called", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  max-mode: turbo\n---\n");
    let called = false;
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async () => { called = true; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: { autopilot: "full" } as Config, backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("allow");
    expect(called).toBe(false);
  });

  it("project budget clamps below config: budget:0 → allow, judge not called", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  budget: 0\n---\n");
    let called = false;
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async () => { called = true; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: { autopilot: "nudge", autopilotBudget: 10 } as Config, backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("allow");
    expect(called).toBe(false);
  });

  it("project prose reaches the judge prompt", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  max-mode: full\n---\n## Rules\n- SENTINEL-PROSE\n");
    let seenPrompt = "";
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async (req) => { seenPrompt = req.prompt; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: { autopilot: "full" } as Config, backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("block");
    expect(seenPrompt).toContain("SENTINEL-PROSE");
  });

  it("clamp that lowers but doesn't disable: config full + project nudge → judge sees nudge-mode system prompt", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  max-mode: nudge\n---\n");
    let seenSystem = "";
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async (req) => { seenSystem = req.system; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: { autopilot: "full" } as Config, backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("block");           // still continues (nudge authority)
    expect(seenSystem).not.toContain("typical next step"); // but without full-mode next-step authority
  });

  it("no project file → behaves exactly as before (nudge continues)", async () => {
    const home = await tmpHome();
    const cwd = await mkdtemp(join(tmpdir(), "grad-empty-"));
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: { autopilot: "nudge" } as Config, backend: fakeBackend(CONTINUE), readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("block");
  });
});
