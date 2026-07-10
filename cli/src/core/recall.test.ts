import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildRecallIndex,
  extractTriggers,
  loadRecallIndex,
  matchPrompt,
  RECALL_THRESHOLD,
  recallIndexFresh,
  recallIndexPath,
  saveRecallIndex,
  type RecallEntry,
} from "./recall.js";

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-rec-"));
  home = await mkdtemp(join(tmpdir(), "grad-rec-home-"));
});

async function seed(): Promise<void> {
  await mkdir(join(dir, ".claude", "skills", "lgtm"), { recursive: true });
  await writeFile(
    join(dir, ".claude", "skills", "lgtm", "SKILL.md"),
    `---\nname: "lgtm"\ndescription: "Approve the PR. Use when the user says things like: \\"lgtm\\", \\"looks good\\"."\n---\nApprove and merge.\n`,
  );
  await mkdir(join(home, ".claude", "commands"), { recursive: true });
  await writeFile(
    join(home, ".claude", "commands", "prep.md"),
    `---\ndescription: "Prep the current branch's PR for shipping"\n---\nSync it with main, verify it's green, review it, and open the PR.\n`,
  );
}

describe("buildRecallIndex", () => {
  it("indexes project skills and user commands with triggers and signatures", async () => {
    await seed();
    const index = await buildRecallIndex(dir, home);
    expect(index.entries.map(entry => entry.invocation).sort()).toEqual(["/lgtm", "/prep"]);

    const lgtm = index.entries.find(entry => entry.name === "lgtm")!;
    expect(lgtm).toMatchObject({ kind: "skill", triggers: ["lgtm", "looks good"] });
    expect(lgtm.signature).toContain("approve and merge");

    const prep = index.entries.find(entry => entry.name === "prep")!;
    expect(prep).toMatchObject({ kind: "command", triggers: [] });
    expect(prep.description).toContain("prep the current branch's pr");
  });

  it("indexes all four project/user command/skill roots", async () => {
    for (const [root, name, file] of [
      [join(dir, ".claude", "commands"), "project-command", "project-command.md"],
      [join(home, ".claude", "skills", "user-skill"), "user-skill", "SKILL.md"],
    ] as const) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, file), `---\ndescription: "${name}"\n---\n${name} body\n`);
    }
    await seed();
    const index = await buildRecallIndex(dir, home);
    expect(index.entries.map(entry => entry.name).sort()).toEqual([
      "lgtm",
      "prep",
      "project-command",
      "user-skill",
    ]);
  });

  it("returns an empty index when no artifact directories exist", async () => {
    expect((await buildRecallIndex(dir, home)).entries).toEqual([]);
  });

  it("caps normalized body signatures at 200 characters", async () => {
    await mkdir(join(dir, ".claude", "commands"), { recursive: true });
    await writeFile(join(dir, ".claude", "commands", "long.md"), "x".repeat(300));
    const [entry] = (await buildRecallIndex(dir, home)).entries;
    expect(entry.signature).toHaveLength(200);
  });
});

describe("save/load/freshness", () => {
  it("round-trips and reports stale after an artifact root changes", async () => {
    await seed();
    const index = await buildRecallIndex(dir, home);
    await saveRecallIndex(dir, index, home);
    expect(recallIndexPath(dir, home)).toContain(join(home, ".config", "gradient", "projects"));
    expect(await loadRecallIndex(dir, home)).toEqual(index);
    expect(await recallIndexFresh(index, dir, home)).toBe(true);

    const future = new Date(Date.parse(index.builtAt) + 60_000);
    await utimes(join(dir, ".claude", "skills"), future, future);
    expect(await recallIndexFresh(index, dir, home)).toBe(false);
  });

  it("reports stale after an existing artifact file is edited", async () => {
    await seed();
    const index = await buildRecallIndex(dir, home);
    const future = new Date(Date.parse(index.builtAt) + 60_000);
    await utimes(join(dir, ".claude", "skills", "lgtm", "SKILL.md"), future, future);
    expect(await recallIndexFresh(index, dir, home)).toBe(false);
  });

  it("returns null for absent, corrupt, or structurally invalid indexes", async () => {
    expect(await loadRecallIndex(dir, home)).toBeNull();
    await mkdir(dirname(recallIndexPath(dir, home)), { recursive: true });
    await writeFile(recallIndexPath(dir, home), "{nope");
    expect(await loadRecallIndex(dir, home)).toBeNull();
    await writeFile(recallIndexPath(dir, home), JSON.stringify({ builtAt: 3, entries: {} }));
    expect(await loadRecallIndex(dir, home)).toBeNull();
  });

  it("writes valid JSON in the private user cache", async () => {
    const index = await buildRecallIndex(dir, home);
    await saveRecallIndex(dir, index, home);
    expect(JSON.parse(await readFile(recallIndexPath(dir, home), "utf8"))).toEqual(index);
  });

  it("rejects a cache timestamp from the future", async () => {
    const index = { builtAt: new Date(Date.now() + 60 * 60_000).toISOString(), entries: [] };
    await mkdir(dirname(recallIndexPath(dir, home)), { recursive: true });
    await writeFile(recallIndexPath(dir, home), JSON.stringify(index));
    expect(await loadRecallIndex(dir, home)).toBeNull();
    expect(await recallIndexFresh(index, dir, home)).toBe(false);
  });
});

describe("extractTriggers", () => {
  it("parses the Phase A description clause", () => {
    expect(extractTriggers('T. Use when the user says things like: "a", "b c".')).toEqual(["a", "b c"]);
    expect(extractTriggers("No clause here")).toEqual([]);
  });

  it("unescapes quotes in trigger phrases", () => {
    expect(extractTriggers('T. Use when the user says things like: "say \\"go\\"".')).toEqual(['say "go"']);
  });
});

const entry = (overrides: Partial<RecallEntry>): RecallEntry => ({
  name: "x",
  kind: "skill",
  invocation: "/x",
  triggers: [],
  signature: "",
  description: "",
  ...overrides,
});

describe("matchPrompt", () => {
  it("matches a retyped trigger phrase after normalization", () => {
    const index = {
      builtAt: "2026-07-09T00:00:00Z",
      entries: [entry({ name: "lgtm", triggers: ["lgtm", "looks good"] })],
    };
    const match = matchPrompt("Looks good!", index);
    expect(match?.entry.name).toBe("lgtm");
    expect(match!.score).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
  });

  it("matches a retyped prompt against the artifact body signature", () => {
    const signature = "push and create a pull request and then review it";
    const index = {
      builtAt: "2026-07-09T00:00:00Z",
      entries: [entry({ name: "ship", signature })],
    };
    const match = matchPrompt("push and create a pull request and then review it.", index);
    expect(match?.entry.name).toBe("ship");
    expect(match!.score).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
  });

  it("compares the description as another recall signal", () => {
    const index = {
      builtAt: "2026-07-09T00:00:00Z",
      entries: [entry({ name: "prep", description: "prepare the current pull request for shipping" })],
    };
    expect(matchPrompt("prepare this pull request for shipping", index)?.entry.name).toBe("prep");
  });

  it("returns the best entry even below the caller's threshold", () => {
    const index = {
      builtAt: "2026-07-09T00:00:00Z",
      entries: [entry({ name: "ship", signature: "push and open a pr" })],
    };
    const match = matchPrompt("explain the auth middleware to me", index);
    expect(match?.entry.name).toBe("ship");
    expect(match!.score).toBeLessThan(RECALL_THRESHOLD);
  });

  it("returns null for an empty index", () => {
    expect(matchPrompt("anything", { builtAt: "2026-07-09T00:00:00Z", entries: [] })).toBeNull();
  });
});
