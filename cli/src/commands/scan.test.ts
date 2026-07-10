import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "./scan.js";
import { playbookPath, MINED_START } from "../core/playbook.js";

describe("scan", () => {
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
      { backend, collectFn: async () => ["f"], parseFn: async () => turns, log: (m) => logs.push(m) },
    );
    expect(logs.some(l => l.includes("top 24"))).toBe(true);
  });

  it("disables the recency cap for --all but keeps it for project scope", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    // 1600 > DEFAULT_MAX_PROMPTS (1500): project scope caps, --all must not.
    const big = Array.from({ length: 1600 }, (_, i) => ({ ts: String(i).padStart(5, "0"), project: "p", role: "user" as const, text: "continue", sessionId: `s${i % 5}` }));
    const run = async (scope: "all" | "project") => {
      const logs: string[] = [];
      await scan(
        { scope, projectPath: process.cwd(), home },
        { backend: null, collectFn: async () => ["f"], parseFn: async () => big, log: (m) => logs.push(m) },
      );
      return logs;
    };
    expect((await run("all")).some(l => l.includes("capped to most recent"))).toBe(false);
    expect((await run("project")).some(l => l.includes("capped to most recent"))).toBe(true);
  });

  it("runs the pipeline with a mock backend and caches suggestions", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const fakeBackend = {
      name: "fake", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceSignature: "push and create a pull request",
        name: "ship", title: "Ship", rationale: "r", confidence: "high",
        payload: { type: "command", commandName: "ship", body: "push and open a PR" },
      }] }),
    };
    const out = await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend: fakeBackend,
        collectFn: async () => ["fake.jsonl"],
        parseFn: async () => [
          { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s1" },
          { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s2" },
          { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s3" },
        ],
      },
    );
    expect(out[0].name).toBe("ship");
    const cached = JSON.parse(await readFile(join(projectDir, ".gradient", "suggestions.json"), "utf8"));
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
        parseFn: async () => [],
        gitLogFn: async () => "https://claude.ai/code/session_01GONE\n",
        log: (m) => logs.push(m),
      },
    );
    expect(logs.some(l => l.includes("coverage: 1 bridged transcript"))).toBe(true);
    expect(logs.some(l => l.includes("coverage: 1 session(s)"))).toBe(true);
  });

  it("writes the playbook after caching suggestions", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const fakeBackend = {
      name: "fake", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceSignatures: ["continue until actually done"],
        name: "keep-going", title: "Keep going", rationale: "r", confidence: "high",
        payload: { type: "loop", instruction: "continue until actually done" },
      }] }),
    };
    await scan(
      { scope: "project", projectPath: projectDir, home },
      {
        backend: fakeBackend,
        collectFn: async () => ["fake.jsonl"],
        parseFn: async () =>
          Array.from({ length: 3 }, (_, i) => ({
            ts: "t", project: "x", role: "user" as const,
            text: "continue until actually done", sessionId: `s${i}`,
          })),
      },
    );
    const pb = await readFile(playbookPath(home), "utf8");
    expect(pb).toContain(MINED_START);
    expect(pb).toContain('"continue until actually done" (seen 3× · 3 sessions)');
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
      { backend: null, collectFn: async () => ["f"], parseFn: async () => turns, log: m => logs.push(m), config: {} },
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
        parseFn: async () => turns,
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
        parseFn: async () => turns,
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
          sourceSignatures: [candidate.signature],
          name: "prefer-pnpm",
          title: "Prefer pnpm",
          rationale: "Repeated preference",
          confidence: "inferred",
          payload: {
            type: "rule",
            target: "project",
            ruleName: "prefer-pnpm",
            text: "Use pnpm as the package manager without asking.",
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
        parseFn: async () => [],
        parseDialogueFn: async () => dialogue,
        log: message => logs.push(message),
      },
    );
    expect(logs.join("\n")).toMatch(/1 repeated-answer pattern/);
    expect(seenKind).toBe("answer");
    expect(suggestions[0].payload).toMatchObject({ type: "rule", ruleName: "prefer-pnpm" });
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
        parseFn: async () => turns,
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
      { backend: null, collectFn: async () => ["f"], parseFn: async () => seqTurns, log: m => logs.push(m) },
    );
    expect(logs.join("\n")).toContain("sequences: 1 recurring chain(s)");
    // Degraded path: the sequence candidate surfaces as a high-confidence command suggestion.
    expect(out.some(s => s.payload.type === "command" && /review the spec → write the plan/.test(s.title))).toBe(true);
  });
});
