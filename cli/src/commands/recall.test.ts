import { beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { adoptionPath, recallHook, recallStatus, setRecall } from "./recall.js";
import { loadRecallIndex, recallIndexPath, saveRecallIndex } from "../core/recall.js";
import { applyByIds } from "./apply.js";
import { migrate } from "./migrate.js";
import { remove } from "./remove.js";
import { review } from "./review.js";
import { scan } from "./scan.js";
import { addEntry, artifactMarker } from "../core/manifest.js";
import { projectKey, saveConfig } from "../config.js";
import { suggestionsPath } from "./apply.js";
import { recordArtifactApproval } from "../core/approvals.js";

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-rc-"));
  home = await mkdtemp(join(tmpdir(), "grad-rc-home-"));
});

const INDEX = {
  builtAt: new Date().toISOString(),
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
  beforeEach(async () => {
    await saveConfig({ recallProjects: [projectKey(dir)] }, home);
  });

  it("is inert without private per-project consent", async () => {
    await saveConfig({}, home);
    await saveRecallIndex(dir, INDEX, home);
    expect(await recallHook(
      { prompt: "push and create a pull request and then review it", cwd: dir },
      { home },
    )).toEqual({});
    await expect(access(adoptionPath(dir, home))).rejects.toThrow();
  });

  it("hints on a matching prompt and logs only adoption metadata", async () => {
    await saveRecallIndex(dir, INDEX, home);
    const result = await recallHook(
      { prompt: "push and create a pull request and then review it.", cwd: dir, session_id: "s1" },
      { home, now: () => "2026-07-09T12:00:00Z" },
    );
    expect(result.context).toContain('skill "/ship"');

    const line = (await readFile(adoptionPath(dir, home), "utf8")).trim();
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
    await saveRecallIndex(dir, INDEX, home);
    expect(await recallHook({ prompt: "push and open a pull request", cwd: dir }, { home })).toEqual({});
    const event = JSON.parse((await readFile(adoptionPath(dir, home), "utf8")).trim());
    expect(event).toMatchObject({ artifact: "ship", hinted: false });
    expect(event.similarity).toBeGreaterThanOrEqual(0.4);
    expect(event.similarity).toBeLessThan(0.55);
  });

  it("stays silent on short, slash-prefixed, and unrelated prompts", async () => {
    await saveRecallIndex(dir, INDEX, home);
    expect(await recallHook({ prompt: "continue", cwd: dir }, { home })).toEqual({});
    expect(await recallHook({ prompt: "/ship the thing now please", cwd: dir }, { home })).toEqual({});
    expect(await recallHook({ prompt: "explain the auth middleware design to me", cwd: dir }, { home })).toEqual({});
    await expect(access(adoptionPath(dir, home))).rejects.toThrow();
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
    await mkdir(dirname(recallIndexPath(dir, home)), { recursive: true });
    await writeFile(recallIndexPath(dir, home), "{broken");
    await expect(
      recallHook({ prompt: "a valid but unmatched prompt", cwd: dir }, { home }),
    ).resolves.toEqual({});
  });

  it("still returns the hint when adoption logging fails", async () => {
    await saveRecallIndex(dir, INDEX, home);
    await mkdir(adoptionPath(dir, home));
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
    const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.local.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0]).toEqual({
      type: "command",
      command: "gradient recall",
      timeout: 5,
    });
    expect(await recallStatus(dir, home)).toMatchObject({ installed: true, entries: 0 });
    expect((await recallStatus(dir, home)).builtAt).toBeTruthy();
  });

  it("removes only the recall hook", async () => {
    await setRecall(true, dir, home);
    await setRecall(false, dir, home);
    expect((await recallStatus(dir, home)).installed).toBe(false);
  });

  it("upgrades an existing recall hook to timeout 5", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          hooks: [{ type: "command", command: "gradient recall" }],
        }],
      },
    }));
    await setRecall(true, dir, home);
    const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.local.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(5);
  });
});

async function seedSuggestion(name: string): Promise<void> {
  const path = suggestionsPath(dir, home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify([{
    id: `id-${name}`,
    name,
    title: `Run ${name}`,
    rationale: "",
    confidence: "high",
    evidence: { count: 3, sessions: 2 },
    payload: {
      type: "command",
      commandName: name,
      body: `${name} body workflow`,
      triggers: [`run ${name}`],
    },
  }]));
}

describe("recall index synchronization", () => {
  beforeEach(async () => {
    await setRecall(true, dir, home);
  });

  it("apply and remove keep the index synchronized", async () => {
    await seedSuggestion("ship");
    await applyByIds(["id-ship"], dir, { home });
    expect((await loadRecallIndex(dir, home))?.entries.some(entry => entry.name === "ship")).toBe(true);

    await remove(dir, "ship", { home });
    expect((await loadRecallIndex(dir, home))?.entries.some(entry => entry.name === "ship")).toBe(false);
  });

  it("review refreshes the index after approving a suggestion", async () => {
    await seedSuggestion("reviewed");
    await review(dir, async () => "approve", { home });
    expect((await loadRecallIndex(dir, home))?.entries.some(entry => entry.name === "reviewed")).toBe(true);
  });

  it("migrate refreshes the index after converting a command", async () => {
    const commandPath = join(dir, ".claude", "commands", "legacy.md");
    await mkdir(join(dir, ".claude", "commands"), { recursive: true });
    const entry = {
      name: "legacy",
      type: "command" as const,
      path: commandPath,
      createdAt: "2026-07-01",
      suggestionId: "legacy-id",
    };
    const content = `---\ndescription: "Legacy workflow"\n---\n${artifactMarker(entry)}\nDo legacy work.\n`;
    await writeFile(commandPath, content);
    await addEntry(dir, entry);
    await recordArtifactApproval(dir, entry, content, home);

    await migrate(dir, { home });
    expect((await loadRecallIndex(dir, home))?.entries).toContainEqual(expect.objectContaining({
      name: "legacy",
      kind: "skill",
    }));
  });

  it("scan refreshes the index to pick up hand-written artifacts", async () => {
    await mkdir(join(dir, ".claude", "skills", "hand-written"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "skills", "hand-written", "SKILL.md"),
      `---\ndescription: "Hand-written workflow"\n---\nDo the hand-written workflow.\n`,
    );
    await scan(
      { scope: "project", projectPath: dir, home },
      { backend: null, collectFn: async () => [], config: {} },
    );
    expect((await loadRecallIndex(dir, home))?.entries.some(entry => entry.name === "hand-written")).toBe(true);
  });
});
