import { beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "./bundle.js";
import { addEntry, removeEntry } from "./manifest.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-bun-"));
});

async function seedSkill(name: string): Promise<void> {
  const path = join(dir, ".claude", "skills", name, "SKILL.md");
  await mkdir(join(dir, ".claude", "skills", name), { recursive: true });
  await writeFile(path, `---\nname: ${JSON.stringify(name)}\ndescription: "d"\n---\nbody\n`);
  await addEntry(dir, {
    name,
    type: "skill",
    path,
    createdAt: "2026-07-01",
    suggestionId: `sig-${name}`,
  });
}

describe("buildBundle", () => {
  it("copies manifest skills into a valid plugin shell", async () => {
    await seedSkill("ship");
    const result = await buildBundle(dir, "Team Toolkit!");
    expect(result.dir).toContain(join(".gradient", "bundle", "team-toolkit"));
    const manifest = JSON.parse(await readFile(join(result.dir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest).toEqual({
      name: "team-toolkit",
      description: "Workflows mined from real usage by gradient",
      version: "0.1.0",
    });
    expect(await readFile(join(result.dir, "skills", "ship", "SKILL.md"), "utf8")).toContain("body");
    expect(await readFile(join(result.dir, "README.md"), "utf8")).toContain("gradient");
  });

  it("copies legacy commands and project rules to their plugin locations", async () => {
    const command = join(dir, ".claude", "commands", "ship.md");
    const rule = join(dir, ".claude", "rules", "gradient-prefer-pnpm.md");
    await mkdir(join(dir, ".claude", "commands"), { recursive: true });
    await mkdir(join(dir, ".claude", "rules"), { recursive: true });
    await writeFile(command, "legacy command\n");
    await writeFile(rule, "project rule\n");
    await addEntry(dir, { name: "ship", type: "command", path: command, createdAt: "2026-07-01", suggestionId: "c1" });
    await addEntry(dir, { name: "prefer-pnpm", type: "rule", path: rule, createdAt: "2026-07-01", suggestionId: "r1" });

    const result = await buildBundle(dir, "kit");
    expect(await readFile(join(result.dir, "commands", "ship.md"), "utf8")).toContain("legacy command");
    expect(await readFile(join(result.dir, "rules", "gradient-prefer-pnpm.md"), "utf8")).toContain("project rule");
    expect(await readFile(join(result.dir, "README.md"), "utf8")).toContain("do not auto-load rules");
  });

  it("skips pathless and unreadable entries without copying suggestions or evidence", async () => {
    await seedSkill("ship");
    await addEntry(dir, { name: "a-loop", type: "loop", path: "", createdAt: "2026-07-01", suggestionId: "s2" });
    await addEntry(dir, {
      name: "ghost",
      type: "skill",
      path: join(dir, ".claude", "skills", "ghost", "SKILL.md"),
      createdAt: "2026-07-01",
      suggestionId: "s3",
    });
    await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([{ evidence: { count: 999 } }]));

    const result = await buildBundle(dir, "kit");
    expect(result.skipped.sort()).toEqual(["a-loop", "ghost"]);
    expect(await readdir(result.dir)).not.toContain("suggestions.json");
    expect(await readFile(join(result.dir, "README.md"), "utf8")).not.toMatch(/seen \d+×/);
  });

  it("refuses to read a manifest path outside the project's .claude directory", async () => {
    const secretDir = await mkdtemp(join(tmpdir(), "grad-secret-"));
    const secret = join(secretDir, "secret.txt");
    await writeFile(secret, "DO_NOT_BUNDLE");
    await addEntry(dir, { name: "stolen", type: "skill", path: secret, createdAt: "2026-07-01", suggestionId: "evil" });
    const result = await buildBundle(dir, "kit");
    expect(result.skipped).toContain("stolen");
    expect((await Promise.all(result.files.map(file => readFile(file, "utf8")))).join("\n")).not.toContain("DO_NOT_BUNDLE");
  });

  it("rebuilds from scratch so removed artifacts cannot remain stale", async () => {
    await seedSkill("ship");
    const first = await buildBundle(dir, "kit");
    const bundledSkill = join(first.dir, "skills", "ship", "SKILL.md");
    await expect(access(bundledSkill)).resolves.toBeUndefined();
    await removeEntry(dir, "ship");
    await buildBundle(dir, "kit");
    await expect(access(bundledSkill)).rejects.toThrow();
  });

  it("writes a valid shell for an empty manifest", async () => {
    const result = await buildBundle(dir, "kit");
    expect(result.files.some(file => file.endsWith("plugin.json"))).toBe(true);
    expect(result.skipped).toEqual([]);
  });
});
