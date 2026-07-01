import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "./scan.js";

describe("scan", () => {
  it("sends up to DEFAULT_DETECT_WINDOW candidates to the llm", async () => {
    const logs: string[] = [];
    // 30 distinct prompts, each repeated 3× → 30 candidates over minCount
    const turns = Array.from({ length: 30 }, (_, i) =>
      Array.from({ length: 3 }, (_, j) => ({ ts: `t${i}`, project: "p", role: "user" as const, text: `distinct prompt number ${i}`, sessionId: `s${j}` }))
    ).flat();
    const backend = { name: "f", available: async () => true, complete: async () => JSON.stringify({ suggestions: [] }) };
    await scan(
      { scope: "all", projectPath: process.cwd() },
      { backend, collectFn: async () => ["f"], parseFn: async () => turns, log: (m) => logs.push(m) },
    );
    expect(logs.some(l => l.includes("top 24"))).toBe(true);
  });

  it("disables the recency cap for --all but keeps it for project scope", async () => {
    // 1600 > DEFAULT_MAX_PROMPTS (1500): project scope caps, --all must not.
    const big = Array.from({ length: 1600 }, (_, i) => ({ ts: String(i).padStart(5, "0"), project: "p", role: "user" as const, text: "continue", sessionId: `s${i % 5}` }));
    const run = async (scope: "all" | "project") => {
      const logs: string[] = [];
      await scan(
        { scope, projectPath: process.cwd() },
        { backend: null, collectFn: async () => ["f"], parseFn: async () => big, log: (m) => logs.push(m) },
      );
      return logs;
    };
    expect((await run("all")).some(l => l.includes("capped to most recent"))).toBe(false);
    expect((await run("project")).some(l => l.includes("capped to most recent"))).toBe(true);
  });

  it("runs the pipeline with a mock backend and caches suggestions", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-"));
    const fakeBackend = {
      name: "fake", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceSignature: "push and create a pull request",
        name: "ship", title: "Ship", rationale: "r", confidence: "high",
        payload: { type: "command", commandName: "ship", body: "push and open a PR" },
      }] }),
    };
    const out = await scan(
      { scope: "project", projectPath: projectDir },
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
});
