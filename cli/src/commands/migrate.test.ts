import { beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEntry, loadManifest } from "../core/manifest.js";
import { migrate, splitCommandFile } from "./migrate.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-mig-"));
});

async function seedCommand(name: string, relative = false): Promise<string> {
  const absolute = join(dir, ".claude", "commands", `${name}.md`);
  await mkdir(join(dir, ".claude", "commands"), { recursive: true });
  await writeFile(absolute, `---\ndescription: "Fix the push"\n---\nDo the fix.\n`);
  await addEntry(dir, {
    name,
    type: "command",
    path: relative ? `.claude/commands/${name}.md` : absolute,
    createdAt: "2026-07-01",
    suggestionId: "x",
  });
  return absolute;
}

describe("splitCommandFile", () => {
  it("extracts JSON-string descriptions and supports CRLF frontmatter", () => {
    expect(splitCommandFile("---\r\ndescription: \"Fix \\\"push\\\"\"\r\n---\r\nDo it.\r\n")).toEqual({
      description: 'Fix "push"',
      body: "Do it.\r\n",
    });
  });

  it("treats a file without frontmatter as body-only", () => {
    expect(splitCommandFile("Do it.\n")).toEqual({ description: "", body: "Do it.\n" });
  });
});

describe("migrate", () => {
  it("converts a tracked command into a skill and deletes the old file", async () => {
    const old = await seedCommand("fix-push", true);
    const result = await migrate(dir);

    expect(result).toEqual({ migrated: ["fix-push"], skipped: [] });
    const skillPath = join(dir, ".claude", "skills", "fix-push", "SKILL.md");
    const skill = await readFile(skillPath, "utf8");
    expect(skill).toContain('name: "fix-push"');
    expect(skill).toContain('description: "Fix the push"');
    expect(skill).toContain("Do the fix.");
    await expect(stat(old)).rejects.toThrow();
    expect((await loadManifest(dir))[0]).toMatchObject({
      name: "fix-push",
      type: "skill",
      path: skillPath,
      createdAt: "2026-07-01",
      suggestionId: "x",
    });
  });

  it("dry-run reports migrations without changing files or the manifest", async () => {
    const old = await seedCommand("fix-push");
    const result = await migrate(dir, { dryRun: true });

    expect(result).toEqual({ migrated: ["fix-push"], skipped: [] });
    await expect(stat(old)).resolves.toBeTruthy();
    await expect(access(join(dir, ".claude", "skills", "fix-push", "SKILL.md"))).rejects.toThrow();
    expect((await loadManifest(dir))[0].type).toBe("command");
  });

  it("skips missing command files and ignores non-command entries", async () => {
    await addEntry(dir, {
      name: "ghost",
      type: "command",
      path: join(dir, ".claude", "commands", "ghost.md"),
      createdAt: "2026-07-01",
      suggestionId: "y",
    });
    await addEntry(dir, {
      name: "a-loop",
      type: "loop",
      path: "",
      createdAt: "2026-07-01",
      suggestionId: "z",
    });

    expect(await migrate(dir)).toEqual({ migrated: [], skipped: ["ghost"] });
  });

  it("leaves untracked command files untouched", async () => {
    const untracked = join(dir, ".claude", "commands", "hand-written.md");
    await mkdir(join(dir, ".claude", "commands"), { recursive: true });
    await writeFile(untracked, "Hand-written workflow.\n");

    expect(await migrate(dir)).toEqual({ migrated: [], skipped: [] });
    expect(await readFile(untracked, "utf8")).toBe("Hand-written workflow.\n");
  });

  it("does not read or delete a tampered manifest path outside .claude", async () => {
    const victim = join(dir, "victim.md");
    await writeFile(victim, "keep me\n");
    await addEntry(dir, {
      name: "evil",
      type: "command",
      path: victim,
      createdAt: "2026-07-01",
      suggestionId: "evil",
    });

    expect(await migrate(dir)).toEqual({ migrated: [], skipped: ["evil"] });
    expect(await readFile(victim, "utf8")).toBe("keep me\n");
  });

  it("does not overwrite an untracked skill at the migration target", async () => {
    const old = await seedCommand("fix-push");
    const skillPath = join(dir, ".claude", "skills", "fix-push", "SKILL.md");
    await mkdir(join(dir, ".claude", "skills", "fix-push"), { recursive: true });
    await writeFile(skillPath, "hand-written skill\n");

    expect(await migrate(dir)).toEqual({ migrated: [], skipped: ["fix-push"] });
    expect(await readFile(skillPath, "utf8")).toBe("hand-written skill\n");
    await expect(stat(old)).resolves.toBeTruthy();
    expect((await loadManifest(dir))[0].type).toBe("command");
  });
});
