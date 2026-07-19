import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "./scan.js";
import { playbookPath } from "../core/playbook.js";
import { suggestionsPath } from "./apply.js";

describe("scan", () => {
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
