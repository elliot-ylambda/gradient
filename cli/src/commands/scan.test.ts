import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TOOL_EVENTS, scan } from "./scan.js";
import { playbookPath } from "../core/playbook.js";
import { suggestionsPath } from "./apply.js";
import type { ToolEvent } from "../core/types.js";
import { auditCachePath } from "../core/audit.js";

describe("scan", () => {
  it("audits project instructions and persists private effectiveness tallies", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-audit-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await writeFile(join(projectDir, "CLAUDE.md"), "- Always use pnpm, never npm.\n");
    const logs: string[] = [];
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend: null,
        config: {},
        collectFn: async () => ["f1"],
        parseFn: async () => [
          { ts: "2026-07-01T00:00:00Z", project: "p", role: "user", sessionId: "s1", text: "use pnpm never npm" },
          { ts: "2026-07-01T00:01:00Z", project: "p", role: "user", sessionId: "s1", text: "always use pnpm never npm" },
          { ts: "2026-07-02T00:00:00Z", project: "p", role: "user", sessionId: "s2", text: "use pnpm not npm please" },
        ],
        attentionFn: async () => null,
        log: message => logs.push(message),
      },
    );
    const snapshot = JSON.parse(await readFile(auditCachePath(projectDir, home), "utf8"));
    expect(snapshot.tallies[0]).toMatchObject({ restatements: 3, violations: 0 });
    expect(logs.some(message => message.startsWith("instruction audit:"))).toBe(true);
    await expect(readFile(join(projectDir, ".gradient", "audit.json"), "utf8")).rejects.toThrow();
  });

  it("does not create an audit cache or log when the project has no instruction sources", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-audit-empty-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const logs: string[] = [];
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend: null,
        config: {},
        collectFn: async () => ["f1"],
        parseFn: async () => [],
        attentionFn: async () => null,
        log: message => logs.push(message),
      },
    );
    await expect(readFile(auditCachePath(projectDir, home), "utf8")).rejects.toThrow();
    expect(logs.some(message => message.startsWith("instruction audit:"))).toBe(false);
  });

  it("does not apply project CLAUDE instructions to cross-project scans", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-audit-all-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await writeFile(join(projectDir, "CLAUDE.md"), "- Always use pnpm, never npm.\n");
    const logs: string[] = [];
    await scan(
      { scope: "all", projectPath: projectDir, home },
      {
        backend: null,
        config: {},
        collectFn: async () => ["f1"],
        parseFn: async () => [
          { ts: "t", project: "other", role: "user", sessionId: "s1", text: "use pnpm never npm" },
          { ts: "t", project: "other", role: "user", sessionId: "s2", text: "use pnpm never npm" },
          { ts: "t", project: "other", role: "user", sessionId: "s3", text: "use pnpm never npm" },
        ],
        attentionFn: async () => null,
        log: message => logs.push(message),
      },
    );
    expect(logs.some(message => message.startsWith("instruction audit:"))).toBe(false);
  });

  it("counts corrections only when the real transcript shows preceding assistant activity", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-audit-context-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const transcript = join(projectDir, "corrections.jsonl");
    await writeFile(join(projectDir, "CLAUDE.md"), "- Never edit generated files.\n");
    const lines: string[] = [];
    for (let index = 1; index <= 3; index++) {
      const sessionId = `s${index}`;
      lines.push(
        JSON.stringify({
          type: "assistant",
          sessionId,
          timestamp: `2026-07-0${index}T00:00:00Z`,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: `edit-${index}`, name: "Edit", input: { file_path: "/p/generated.ts" } }],
          },
        }),
        JSON.stringify({
          type: "user",
          sessionId,
          cwd: "/p/project",
          timestamp: `2026-07-0${index}T00:01:00Z`,
          message: { role: "user", content: "no, never edit generated files" },
        }),
      );
    }
    await writeFile(transcript, `${lines.join("\n")}\n`);
    let seen: Array<{ kind?: string; hint?: string }> = [];
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        config: {},
        collectFn: async () => [transcript],
        backend: {
          name: "recording",
          available: async () => true,
          complete: async ({ prompt }: { prompt: string }) => {
            seen = JSON.parse(prompt);
            return JSON.stringify({ suggestions: [] });
          },
        },
        attentionFn: async () => null,
        gitLogFn: async () => "",
      },
    );
    expect(seen).toEqual([expect.objectContaining({
      kind: "instruction",
      hint: expect.stringContaining("correction violating instruction"),
    })]);
    const snapshot = JSON.parse(await readFile(auditCachePath(projectDir, home), "utf8"));
    expect(snapshot.tallies[0]).toMatchObject({ restatements: 0, violations: 3 });
  });

  it("mines Claude tool events into candidates and reports extraction drops", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-tools-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const logs: string[] = [];
    const failure = (sessionId: string): ToolEvent => ({
      ts: "2026-07-01T00:00:00Z",
      sessionId,
      kind: "bash",
      command: "npm test",
      isError: true,
      errorHead: "FAIL",
    });
    const events = [failure("s1"), failure("s1"), failure("s2"), failure("s2")];
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend: null,
        config: {},
        collectFn: async () => ["f1"],
        parseFn: async () => [],
        parseToolEventsFn: async () => ({ events, dropped: 2 }),
        attentionFn: async () => null,
        log: message => logs.push(message),
      },
    );
    expect(logs).toContain("tool events: 4 (2 dropped) → 1 failure loops, 0 rituals");
  });

  it("skips tool parsing when mineToolEvents is disabled", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-tools-off-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    let called = false;
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend: null,
        config: { mineToolEvents: false },
        collectFn: async () => ["f1"],
        parseFn: async () => [],
        parseToolEventsFn: async () => {
          called = true;
          return { events: [], dropped: 0 };
        },
        attentionFn: async () => null,
      },
    );
    expect(called).toBe(false);
  });

  it("enforces and reports the global tool-event cap", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-tools-cap-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const logs: string[] = [];
    const events: ToolEvent[] = Array.from({ length: MAX_TOOL_EVENTS + 5 }, (_, index) => ({
      ts: `2026-07-01T00:00:${String(index).padStart(5, "0")}Z`,
      sessionId: `s${index}`,
      kind: "bash",
      command: `echo ${index}`,
      isError: false,
    }));
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend: null,
        config: {},
        collectFn: async () => ["f1"],
        parseFn: async () => [],
        parseToolEventsFn: async () => ({ events, dropped: 0 }),
        attentionFn: async () => null,
        log: message => logs.push(message),
      },
    );
    expect(logs).toContain(`tool events: ${MAX_TOOL_EVENTS} (5 dropped) → 0 failure loops, 0 rituals`);
  });

  it("feeds one recurring failure and one post-edit ritual through the real parser", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-tools-e2e-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const transcript = join(projectDir, "tools.jsonl");
    const lines: string[] = [];
    let id = 0;
    let second = 0;
    const toolUse = (
      sessionId: string,
      name: string,
      input: Record<string, unknown>,
    ): string => JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: `2026-07-01T00:00:${String(second++ % 60).padStart(2, "0")}Z`,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: `tool-${id}`, name, input }],
      },
    });
    const toolResult = (sessionId: string, isError: boolean, content: string): string => JSON.stringify({
      type: "user",
      sessionId,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `tool-${id++}`, is_error: isError, content }],
      },
    });
    const bash = (sessionId: string, command: string, isError = false, content = "ok"): void => {
      lines.push(toolUse(sessionId, "Bash", { command }), toolResult(sessionId, isError, content));
    };
    const edit = (sessionId: string, index: number): void => {
      lines.push(toolUse(sessionId, "Edit", { file_path: `/p/src/${sessionId}-${index}.ts` }));
      id++;
    };

    for (const sessionId of ["s1", "s2"]) {
      bash(sessionId, "npm test", true, "FAIL src/x.test.ts");
      bash(sessionId, "npm test", true, "FAIL src/x.test.ts");
    }
    const attachedCounts = [6, 5, 5];
    const fillerCounts = [1, 2, 1];
    for (let session = 0; session < 3; session++) {
      const sessionId = `s${session + 1}`;
      for (let index = 0; index < attachedCounts[session]; index++) {
        edit(sessionId, index);
        bash(sessionId, "npm run lint");
      }
      for (let filler = 0; filler < fillerCounts[session]; filler++) {
        edit(sessionId, 100 + filler);
        for (let offset = 0; offset < 3; offset++) {
          bash(sessionId, `echo filler-${sessionId}-${filler}-${offset}`);
        }
      }
    }
    await writeFile(transcript, `${lines.join("\n")}\n`);

    let candidates: Array<{ kind?: string; signature: string }> = [];
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        config: {},
        collectFn: async () => [transcript],
        backend: {
          name: "recording",
          available: async () => true,
          complete: async ({ prompt }: { prompt: string }) => {
            candidates = JSON.parse(prompt);
            return JSON.stringify({ suggestions: [] });
          },
        },
        gitLogFn: async () => "",
        attentionFn: async () => null,
      },
    );

    expect(candidates.map(candidate => [candidate.kind, candidate.signature])).toEqual([
      ["ritual", "npm run lint"],
      ["toolfail", "npm test"],
    ]);
  });

  it("suggests a matched Notification hook when attention gaps cross the session floor", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-attention-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const assistant = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T10:00:00Z",
      message: { role: "assistant", content: [{ type: "text", text: "Proceed?" }] },
    });
    const user = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T10:10:00Z",
      message: { role: "user", content: "yes" },
    });
    const files = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      const path = join(projectDir, `session-${index}.jsonl`);
      await writeFile(path, `${assistant}\n${user}\n`);
      return path;
    }));
    const logs: string[] = [];

    const suggestions = await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        config: {},
        backend: null,
        collectFn: async () => files,
        parseFn: async () => ({ turns: [], events: [] }),
        log: message => logs.push(message),
      },
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].payload).toMatchObject({
      type: "hook",
      event: "Notification",
      matcher: "permission_prompt|idle_prompt",
      subcommand: "notify",
    });
    expect(logs.join("\n")).toContain("notification hook suggested");
    const cached = JSON.parse(await readFile(suggestionsPath(projectDir, home), "utf8"));
    expect(cached[0].id).toBe(suggestions[0].id);
  });

  it("does not suggest a Claude Notification hook from Codex-only history", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-attention-codex-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const suggestions = await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        config: { targets: ["codex"] },
        backend: null,
        collectCodexFn: async () => ["codex-session.jsonl"],
        parseCodexFn: async () => [],
        parseCodexDialogueFn: async () => [],
      },
    );
    expect(suggestions).toEqual([]);
  });

  // Regression: a "continue"-style cluster with runs (maxRunLength 4, runSessions 3)
  // becomes a loop suggestion with zero LLM involvement — markLoops must run on the
  // real cluster/temporal output inside scan(), and the degrade path (backend: null)
  // must turn the marked candidate into a loop suggestion.
  it("marks a 'continue'-style cluster with runs as a loop suggestion in degraded (no-LLM) mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const at = (sessionId: string, times: string[]) =>
      times.map(ts => ({ ts, project: "p", role: "user" as const, text: "continue", sessionId }));
    const turns = [
      ...at("s1", ["2026-06-01T10:00:00Z", "2026-06-01T10:05:00Z", "2026-06-01T10:10:00Z", "2026-06-01T10:15:00Z"]),
      ...at("s2", ["2026-06-02T09:00:00Z", "2026-06-02T09:05:00Z"]),
      ...at("s3", ["2026-06-03T09:00:00Z", "2026-06-03T09:05:00Z"]),
    ];
    const suggestions = await scan(
      { scope: "all", projectPath: process.cwd(), home },
      { backend: null, collectFn: async () => ["f"], parseFn: async () => ({ turns, events: [] }) },
    );
    const loopSuggestion = suggestions.find(s => s.payload.type === "loop");
    expect(loopSuggestion).toBeDefined();
  });

  // Regression: a "don't add comments" correction cluster (4x, 3 sessions) is
  // reclassified as kind "correction" by markCorrections inside scan() — the
  // LLM sees kind "correction" on the wire and, naming it a rule, gets back a
  // correction-shaped rule suggestion (never a plain command).
  it("mines a 'don't add comments' correction cluster into a rule suggestion via scan()", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const at = (sessionId: string, times: string[]) =>
      times.map(ts => ({ ts, project: "p", role: "user" as const, text: "don't add comments", sessionId }));
    const turns = [
      ...at("s1", ["2026-06-01T10:00:00Z"]),
      ...at("s2", ["2026-06-02T10:00:00Z"]),
      ...at("s3", ["2026-06-03T10:00:00Z", "2026-06-03T11:00:00Z"]),
    ];
    const backend = {
      name: "f",
      available: async () => true,
      complete: async ({ prompt }: { prompt: string }) => {
        const [first] = JSON.parse(prompt);
        expect(first.kind).toBe("correction");
        return JSON.stringify({ suggestions: [{
          sourceIds: [first.id], name: "no-comments", confidence: "inferred",
          payload: { type: "rule", ruleName: "no-comments" },
        }] });
      },
    };
    const suggestions = await scan(
      { scope: "project", projectPath: process.cwd(), home },
      { backend, collectFn: async () => ["f"], parseFn: async () => ({ turns, events: [] }) },
    );
    const rule = suggestions.find(s => s.payload.type === "rule");
    expect(rule).toBeDefined();
    if (rule?.payload.type === "rule") {
      expect(rule.payload.text).toContain("Repeated correction observed");
      expect(rule.payload.target).toBe("project");
    }
  });

  it("does not auto-emit a correction rule when the classifier is unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "grad-project-"));
    const turns = ["s1", "s2", "s3"].map((sessionId, index) => ({
      ts: `2026-06-0${index + 1}T10:00:00Z`, project: "p", role: "user" as const,
      text: "don't add comments", sessionId,
    }));
    const suggestions = await scan(
      { scope: "project", projectPath: projectDir, home },
      { backend: null, collectFn: async () => ["f"], parseFn: async () => ({ turns, events: [] }) },
    );
    expect(suggestions).toEqual([]);
  });

  // Regression: 12 /compact events across 4 sessions produce the PreCompact hook
  // suggestion in degraded (backend null) mode — hookFromEvents must be appended
  // post-detect even when there's no LLM at all.
  it("suggests the PreCompact checkpoint hook from /compact command events in degraded mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const events = ["s1", "s1", "s1", "s2", "s2", "s2", "s3", "s3", "s3", "s4", "s4", "s4"].map(sessionId => ({
      ts: "2026-07-01T00:00:00Z", project: "p", sessionId, command: "/compact",
    }));
    const logs: string[] = [];
    const suggestions = await scan(
      { scope: "all", projectPath: process.cwd(), home },
      {
        backend: null,
        collectFn: async () => ["f"],
        parseFn: async () => ({ turns: [], events }),
        log: message => logs.push(message),
      },
    );
    const hookSuggestion = suggestions.find(s => s.payload.type === "hook" && s.payload.event === "PreCompact");
    expect(hookSuggestion).toBeDefined();
    expect(hookSuggestion?.payload).toMatchObject({ event: "PreCompact", subcommand: "checkpoint" });
    const cached = JSON.parse(await readFile(suggestionsPath(process.cwd(), home), "utf8"));
    expect(cached.some((s: { id: string }) => s.id === hookSuggestion?.id)).toBe(true);
  });

  // Regression: an LLM-sourced PreCompact hook carries a text-candidate-derived
  // id that never equals the event-derived id — dedup must key on the semantic
  // hook type or the user sees the same checkpoint hook twice.
  it("emits exactly one checkpoint hook when the llm and /compact evidence both propose it", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const events = ["s1", "s1", "s1", "s2", "s2", "s2", "s3", "s3", "s3", "s4", "s4", "s4"].map(sessionId => ({
      ts: "2026-07-01T00:00:00Z", project: "p", sessionId, command: "/compact",
    }));
    const turns = ["s1", "s2", "s3"].map(sessionId => ({
      ts: "2026-07-01T00:00:00Z", project: "p", role: "user" as const,
      text: "we keep losing context after compaction", sessionId,
    }));
    const backend = {
      name: "f",
      available: async () => true,
      complete: async ({ prompt }: { prompt: string }) => {
        const [first] = JSON.parse(prompt);
        return JSON.stringify({ suggestions: [{
          sourceIds: [first.id], name: "checkpoint-before-compact", confidence: "high",
          payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint" },
        }] });
      },
    };
    const suggestions = await scan(
      { scope: "all", projectPath: process.cwd(), home },
      { backend, collectFn: async () => ["f"], parseFn: async () => ({ turns, events }), log: () => {} },
    );
    const hooks = suggestions.filter(s => s.payload.type === "hook" && s.payload.event === "PreCompact");
    expect(hooks).toHaveLength(1);
  });

  it("sends up to DEFAULT_DETECT_WINDOW candidates to the llm", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const logs: string[] = [];
    // 30 distinct prompts, each repeated 3× → 30 candidates over minCount
    const turns = Array.from({ length: 30 }, (_, i) =>
      Array.from({ length: 3 }, (_, j) => ({ ts: `t${i}`, project: "p", role: "user" as const, text: `distinct prompt number ${i}`, sessionId: `s${j}` }))
    ).flat();
    const backend = { name: "f", available: async () => true, complete: async () => JSON.stringify({ suggestions: [] }) };
    await scan(
      { scope: "all", projectPath: process.cwd(), home },
      { backend, collectFn: async () => ["f"], parseFn: async () => ({ turns, events: [] }), log: (m) => logs.push(m) },
    );
    expect(logs.some(l => l.includes("top 24"))).toBe(true);
  });

  it("keeps a memory/cost cap for both --all and project scope", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    // 1600 > DEFAULT_MAX_PROMPTS (1500): every scope remains bounded.
    const big = Array.from({ length: 1600 }, (_, i) => ({ ts: String(i).padStart(5, "0"), project: "p", role: "user" as const, text: "continue", sessionId: `s${i % 5}` }));
    const run = async (scope: "all" | "project") => {
      const logs: string[] = [];
      await scan(
        { scope, projectPath: process.cwd(), home },
        { backend: null, collectFn: async () => ["f"], parseFn: async () => ({ turns: big, events: [] }), log: (m) => logs.push(m) },
      );
      return logs;
    };
    expect((await run("all")).some(l => l.includes("capped to most recent"))).toBe(true);
    expect((await run("project")).some(l => l.includes("capped to most recent"))).toBe(true);
  });

  it("applies --since to individual turns, not only transcript file mtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-since-"));
    const seen: string[] = [];
    const backend = {
      name: "fake", available: async () => true,
      complete: async (request: { prompt: string }) => {
        seen.push(request.prompt);
        return JSON.stringify({ suggestions: [] });
      },
    };
    await scan(
      { scope: "all", projectPath: dir, sinceDays: 7, now: Date.parse("2026-07-09T00:00:00Z") },
      {
        backend,
        collectFn: async () => ["recently-touched.jsonl"],
        parseFn: async () => ({
          turns: [
            { ts: "2025-01-01T00:00:00Z", project: "p", role: "user", text: "OLD-CONFIDENTIAL-PROMPT", sessionId: "old" },
            ...Array.from({ length: 3 }, (_, i) => ({ ts: `2026-07-0${7 + i}T00:00:00Z`, project: "p", role: "user" as const, text: "recent repeat", sessionId: `s${i}` })),
          ],
          events: [],
        }),
      },
    );
    expect(seen.join("\n")).not.toContain("OLD-CONFIDENTIAL-PROMPT");
  });

  it("runs the pipeline with a mock backend and caches suggestions", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const fakeBackend = {
      name: "fake", available: async () => true,
      complete: async ({ prompt }: { prompt: string }) => {
        const [candidate] = JSON.parse(prompt);
        return JSON.stringify({ suggestions: [{
          sourceIds: [candidate.id],
          name: "ship", confidence: "high",
          payload: { type: "command", commandName: "ship" },
        }] });
      },
    };
    const out = await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend: fakeBackend,
        collectFn: async () => ["fake.jsonl"],
        parseFn: async () => ({
          turns: [
            { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s1" },
            { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s2" },
            { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s3" },
          ],
          events: [],
        }),
      },
    );
    expect(out[0].name).toBe("ship");
    const cached = JSON.parse(await readFile(suggestionsPath(projectDir, home), "utf8"));
    expect(cached.length).toBe(1);
  });

  it("reports coverage gaps: husk transcripts and trailer sessions missing locally", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const husk = join(projectDir, "husk.jsonl");
    await writeFile(husk, '{"type":"bridge-session","bridgeSessionId":"session_01AAA"}\n');
    const logs: string[] = [];
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend: null,
        collectFn: async () => [husk],
        parseFn: async () => ({ turns: [], events: [] }),
        gitLogFn: async () => "https://claude.ai/code/session_01GONE\n",
        log: (m) => logs.push(m),
      },
    );
    expect(logs.some(l => l.includes("coverage: 1 bridged transcript"))).toBe(true);
    expect(logs.some(l => l.includes("coverage: 1 session(s)"))).toBe(true);
  });

  it("does not write unapproved model output into the autopilot playbook", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const fakeBackend = {
      name: "fake", available: async () => true,
      complete: async ({ prompt }: { prompt: string }) => {
        const [candidate] = JSON.parse(prompt);
        return JSON.stringify({ suggestions: [{
          sourceIds: [candidate.id],
          name: "keep-going", confidence: "high",
          payload: { type: "loop" },
        }] });
      },
    };
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend: fakeBackend,
        collectFn: async () => ["fake.jsonl"],
        parseFn: async () => ({
          turns: Array.from({ length: 3 }, (_, i) => ({
            ts: "t", project: "x", role: "user" as const,
            text: "continue until actually done", sessionId: `s${i}`,
          })),
          events: [],
        }),
      },
    );
    await expect(readFile(playbookPath(home), "utf8")).rejects.toThrow();
  });

  it("excludes template floods from detection and logs the exclusion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    // Redacted sample from the dogfood security-review injector: one identical
    // prompt per session across all 1,318 affected sessions.
    const flood = "Review this change for security vulnerabilities. Changed files (you may read these and any other file in the repo): " + "x".repeat(200);
    const turns = Array.from({ length: 1_318 }, (_, i) => ({
      ts: `2026-07-0${(i % 9) + 1}T00:00:00Z`, project: "p", role: "user" as const,
      sessionId: `s${i}`, text: flood,
    }));
    const logs: string[] = [];
    const out = await scan(
      { scope: "project", projectPath: dir },
      { backend: null, collectFn: async () => ["f"], parseFn: async () => ({ turns, events: [] }), log: m => logs.push(m), config: {} },
    );
    expect(out).toHaveLength(0);
    expect(logs.join("\n")).toContain("excluded 1 machine-template pattern(s)");
  });

  it("applies configured ignore patterns before clustering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const turns = Array.from({ length: 3 }, (_, i) => ({
      ts: `2026-07-0${i + 1}T00:00:00Z`, project: "p", role: "user" as const,
      sessionId: `s${i}`, text: "Site injector: review this build",
    }));
    const out = await scan(
      { scope: "project", projectPath: dir },
      {
        backend: null,
        collectFn: async () => ["f"],
        parseFn: async () => ({ turns, events: [] }),
        config: { ignorePatterns: ["^site injector:"] },
      },
    );
    expect(out).toHaveLength(0);
  });

  it("feeds paste candidates into detection without leaking or double-counting their bodies", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const errorBody = `make dev\n${"error: boom SENSITIVE_BODY\n".repeat(40)}`;
    const turns = ["s1", "s2", "s3"].map(sessionId => ({
      ts: "2026-07-01T00:00:00Z",
      project: "p",
      role: "user" as const,
      sessionId,
      text: errorBody,
    }));
    let seenPrompt = "";
    const logs: string[] = [];
    const backend = {
      name: "fake",
      available: async () => true,
      complete: async ({ prompt }: { prompt: string }) => {
        seenPrompt = prompt;
        return JSON.stringify({ suggestions: [] });
      },
    };
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend,
        collectFn: async () => ["f"],
        parseFn: async () => ({ turns, events: [] }),
        parseDialogueFn: async () => [],
        log: message => logs.push(message),
      },
    );
    expect(logs.join("\n")).toMatch(/1 paste pattern/);
    expect(JSON.parse(seenPrompt)).toHaveLength(1);
    expect(seenPrompt).not.toContain("SENSITIVE_BODY");
  });

  it("feeds repeated structured answers into rule detection", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const logs: string[] = [];
    let seenKind = "";
    const backend = {
      name: "fake",
      available: async () => true,
      complete: async ({ prompt }: { prompt: string }) => {
        const [candidate] = JSON.parse(prompt);
        seenKind = candidate.kind;
        return JSON.stringify({ suggestions: [{
          sourceIds: [candidate.id],
          name: "prefer-pnpm",
          confidence: "inferred",
          payload: {
            type: "rule",
            ruleName: "prefer-pnpm",
          },
        }] });
      },
    };
    const dialogue = ["s1", "s2", "s3"].flatMap(sessionId => [
      { role: "assistant" as const, text: "Which package manager should I use?", sessionId, ts: "t1" },
      { role: "user" as const, text: "pnpm", sessionId, ts: "t2" },
    ]);
    const suggestions = await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend,
        collectFn: async () => ["f"],
        parseFn: async () => ({ turns: [], events: [] }),
        parseDialogueFn: async () => dialogue,
        log: message => logs.push(message),
      },
    );
    expect(logs.join("\n")).toMatch(/1 repeated-answer pattern/);
    expect(seenKind).toBe("answer");
    expect(suggestions[0].payload).toMatchObject({ type: "rule", ruleName: "prefer-pnpm" });
    if (suggestions[0].payload.type === "rule") {
      expect(suggestions[0].payload.text).toContain("not authorization");
    }
  });

  it("does not mine assistant answers across projects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    let dialogueReads = 0;
    let seenPrompt = "";
    await scan(
      { scope: "all", projectPath: dir },
      {
        backend: { name: "fake", available: async () => true, complete: async ({ prompt }: { prompt: string }) => {
          seenPrompt = prompt;
          return JSON.stringify({ suggestions: [] });
        } },
        collectFn: async () => ["a", "b"],
        parseFn: async () => ({ turns: [], events: [] }),
        parseDialogueFn: async () => {
          dialogueReads++;
          return [
            { role: "assistant", text: "Which package manager do you prefer?", sessionId: "s", ts: "t" },
            { role: "user", text: "pnpm", sessionId: "s", ts: "t" },
          ];
        },
      },
    );
    expect(dialogueReads).toBe(0);
    expect(seenPrompt).not.toContain("package manager");
  });

  it("keeps paste-shaped template floods out of detection", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const turns = Array.from({ length: 30 }, (_, i) => ({
      ts: `2026-07-01T00:00:${String(i).padStart(2, "0")}Z`,
      project: "p",
      role: "user" as const,
      sessionId: `s${i}`,
      text: `review-build\n${"error: generated review payload\n".repeat(20)}`,
    }));
    let seenPrompt = "unset";
    const logs: string[] = [];
    const backend = {
      name: "fake",
      available: async () => true,
      complete: async ({ prompt }: { prompt: string }) => {
        seenPrompt = prompt;
        return JSON.stringify({ suggestions: [] });
      },
    };
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend,
        collectFn: async () => ["f"],
        parseFn: async () => ({ turns, events: [] }),
        parseDialogueFn: async () => [],
        log: message => logs.push(message),
      },
    );
    expect(JSON.parse(seenPrompt)).toEqual([]);
    expect(logs.join("\n")).toContain("excluded 1 machine-template pattern");
  });

  it("mines sequences into candidates and logs the sequence count", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const seqTurns = Array.from({ length: 3 }, (_, i) => [
      { ts: "2026-07-01T00:00:00Z", project: "p", role: "user" as const, sessionId: `s${i}`, text: "review the spec" },
      { ts: "2026-07-01T00:01:00Z", project: "p", role: "user" as const, sessionId: `s${i}`, text: "write the plan" },
    ]).flat();
    const logs: string[] = [];
    const out = await scan(
      { scope: "project", projectPath: dir, home },
      { backend: null, collectFn: async () => ["f"], parseFn: async () => ({ turns: seqTurns, events: [] }), log: m => logs.push(m) },
    );
    expect(logs.join("\n")).toContain("sequences: 1 recurring chain(s)");
    // Degraded path: the sequence candidate surfaces as a high-confidence command suggestion.
    expect(out.some(s => s.payload.type === "command" && /review the spec → write the plan/.test(s.title))).toBe(true);
  });

  it("merges the same habit across Claude Code and Codex evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const claudeTurns = ["c1", "c2"].map(sessionId => ({
      ts: "2026-07-01T00:00:00Z",
      project: "gradient",
      role: "user" as const,
      sessionId,
      text: "ship and open the PR",
      assistant: "claude-code" as const,
    }));
    const codexTurns = ["codex:x1", "codex:x2"].map(sessionId => ({
      ts: "2026-07-01T00:01:00Z",
      project: "gradient",
      role: "user" as const,
      sessionId,
      text: "ship and open the PR",
      assistant: "codex" as const,
    }));
    const logs: string[] = [];
    const out = await scan(
      { scope: "project", projectPath: dir, home },
      {
        config: { targets: ["claude-code", "codex"] },
        backend: null,
        collectFn: async () => ["claude.jsonl"],
        collectCodexFn: async () => ["codex.jsonl"],
        parseFn: async () => ({ turns: claudeTurns, events: [] }),
        parseCodexFn: async () => codexTurns,
        parseDialogueFn: async () => [],
        parseCodexDialogueFn: async () => [],
        log: message => logs.push(message),
      },
    );
    expect(logs.join("\n")).toContain("Claude Code 1 · Codex 1");
    expect(logs.join("\n")).toContain("Claude Code 2 prompt(s) · Codex 2 prompt(s)");
    expect(out[0].evidence).toMatchObject({
      count: 4,
      sessions: 4,
      assistants: ["claude-code", "codex"],
    });
  });

  it("routes <command-name> turns to events via the real parseFn, keeping them out of mining", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-cmdevt-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const file = join(projectDir, "session.jsonl");
    const compact = (ts: string) => JSON.stringify({
      type: "user", sessionId: "s1", cwd: "/p/x", timestamp: ts,
      message: { role: "user", content: "<command-name>/compact</command-name>" },
    });
    await writeFile(file, [
      compact("2026-07-01T00:00:00Z"),
      compact("2026-07-02T00:00:00Z"),
      compact("2026-07-03T00:00:00Z"),
    ].join("\n") + "\n");
    const logs: string[] = [];
    const out = await scan(
      { scope: "project", projectPath: projectDir, home },
      { backend: null, collectFn: async () => [file], log: message => logs.push(message) },
    );
    expect(out).toEqual([]);
    expect(logs.some(l => l.includes("prompts: 0 after filtering"))).toBe(true);
  });
});
