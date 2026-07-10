import { beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallHook, recallStatus, setRecall } from "./recall.js";
import { saveRecallIndex } from "../core/recall.js";

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-rc-"));
  home = await mkdtemp(join(tmpdir(), "grad-rc-home-"));
});

const INDEX = {
  builtAt: new Date(Date.now() + 3_600_000).toISOString(),
  entries: [{
    name: "ship",
    kind: "skill" as const,
    invocation: "/ship",
    triggers: ["push and create a pull request and then review it"],
    signature: "",
    description: "",
  }],
};

describe("recallHook", () => {
  it("hints on a matching prompt and logs only adoption metadata", async () => {
    await saveRecallIndex(dir, INDEX);
    const result = await recallHook(
      { prompt: "push and create a pull request and then review it.", cwd: dir, session_id: "s1" },
      { home, now: () => "2026-07-09T12:00:00Z" },
    );
    expect(result.context).toContain('skill "/ship"');

    const line = (await readFile(join(dir, ".gradient", "adoption.jsonl"), "utf8")).trim();
    const event = JSON.parse(line);
    expect(event).toEqual({
      ts: "2026-07-09T12:00:00Z",
      artifact: "ship",
      similarity: 1,
      hinted: true,
    });
    expect(line).not.toContain("push and create");
  });

  it("logs a near miss without hinting", async () => {
    await saveRecallIndex(dir, INDEX);
    expect(await recallHook({ prompt: "push and open a pull request", cwd: dir }, { home })).toEqual({});
    const event = JSON.parse((await readFile(join(dir, ".gradient", "adoption.jsonl"), "utf8")).trim());
    expect(event).toMatchObject({ artifact: "ship", hinted: false });
    expect(event.similarity).toBeGreaterThanOrEqual(0.4);
    expect(event.similarity).toBeLessThan(0.55);
  });

  it("stays silent on short, slash-prefixed, and unrelated prompts", async () => {
    await saveRecallIndex(dir, INDEX);
    expect(await recallHook({ prompt: "continue", cwd: dir }, { home })).toEqual({});
    expect(await recallHook({ prompt: "/ship the thing now please", cwd: dir }, { home })).toEqual({});
    expect(await recallHook({ prompt: "explain the auth middleware design to me", cwd: dir }, { home })).toEqual({});
    await expect(access(join(dir, ".gradient", "adoption.jsonl"))).rejects.toThrow();
  });

  it("builds a missing index inline and can hint immediately", async () => {
    await mkdir(join(dir, ".claude", "skills", "ship"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "skills", "ship", "SKILL.md"),
      `---\nname: "ship"\ndescription: "Ship it. Use when the user says things like: \\"push and create a pull request and then review it\\"."\n---\nbody\n`,
    );
    const result = await recallHook(
      { prompt: "push and create a pull request and then review it", cwd: dir },
      { home },
    );
    expect(result.context).toContain('"/ship"');
  });

  it("rebuilds a corrupt index instead of crashing", async () => {
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "recall.json"), "{broken");
    await expect(
      recallHook({ prompt: "a valid but unmatched prompt", cwd: dir }, { home }),
    ).resolves.toEqual({});
  });

  it("still returns the hint when adoption logging fails", async () => {
    await saveRecallIndex(dir, INDEX);
    await mkdir(join(dir, ".gradient", "adoption.jsonl"));
    const result = await recallHook(
      { prompt: "push and create a pull request and then review it", cwd: dir },
      { home },
    );
    expect(result.context).toContain('"/ship"');
  });

  it("never throws on missing or unusable input", async () => {
    await expect(recallHook({}, { home })).resolves.toEqual({});
    await expect(
      recallHook({ prompt: "x".repeat(20), cwd: "/nonexistent/gradient-recall" }, { home }),
    ).resolves.toEqual({});
  });
});

describe("setRecall / recallStatus", () => {
  it("installs UserPromptSubmit with timeout 5 and builds the index", async () => {
    const result = await setRecall(true, dir, home);
    expect(result.installed).toBe(true);
    const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0]).toEqual({
      type: "command",
      command: "gradient recall",
      timeout: 5,
    });
    expect(await recallStatus(dir)).toMatchObject({ installed: true, entries: 0 });
    expect((await recallStatus(dir)).builtAt).toBeTruthy();
  });

  it("removes only the recall hook", async () => {
    await setRecall(true, dir, home);
    await setRecall(false, dir, home);
    expect((await recallStatus(dir)).installed).toBe(false);
  });
});
