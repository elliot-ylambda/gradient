import { beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "./bundle.js";
import { addEntry, removeEntries } from "./manifest.js";

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
    const codexManifest = JSON.parse(await readFile(join(result.dir, ".codex-plugin", "plugin.json"), "utf8"));
    expect(codexManifest).toMatchObject({
      name: "team-toolkit",
      version: "0.1.0",
      author: { name: "gradient" },
      skills: "./skills/",
      interface: {
        displayName: "team-toolkit",
        category: "Productivity",
      },
    });
    expect(await readFile(join(result.dir, "skills", "ship", "SKILL.md"), "utf8")).toContain("body");
    expect(await readFile(join(result.dir, "README.md"), "utf8")).toContain("gradient");
  });

  it("deduplicates dual-target skills and prefers the portable Codex copy", async () => {
    await seedSkill("ship");
    const codexPath = join(dir, ".agents", "skills", "ship", "SKILL.md");
    await mkdir(join(dir, ".agents", "skills", "ship"), { recursive: true });
    await writeFile(codexPath, '---\nname: "ship"\ndescription: "portable"\n---\nportable body\n');
    await addEntry(dir, {
      name: "ship",
      type: "skill",
      target: "codex",
      path: codexPath,
      createdAt: "2026-07-01",
      suggestionId: "sig-ship",
    });
    const result = await buildBundle(dir, "kit");
    expect(await readFile(join(result.dir, "skills", "ship", "SKILL.md"), "utf8")).toContain("portable body");
    expect(result.skipped).toEqual([]);
  });

  it("exposes legacy commands as Codex-compatible skills too", async () => {
    const command = join(dir, ".claude", "commands", "ship.md");
    await mkdir(join(dir, ".claude", "commands"), { recursive: true });
    await writeFile(command, '---\nname: "ship"\ndescription: "ship"\n---\nship body\n');
    await addEntry(dir, { name: "ship", type: "command", path: command, createdAt: "2026-07-01", suggestionId: "c1" });
    const result = await buildBundle(dir, "kit");
    expect(await readFile(join(result.dir, "commands", "ship.md"), "utf8")).toContain("ship body");
    expect(await readFile(join(result.dir, "skills", "ship", "SKILL.md"), "utf8")).toContain("ship body");
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
    await removeEntries(dir, "ship");
    await buildBundle(dir, "kit");
    await expect(access(bundledSkill)).rejects.toThrow();
  });

  it("writes a valid shell for an empty manifest", async () => {
    const result = await buildBundle(dir, "kit");
    expect(result.files.some(file => file.endsWith("plugin.json"))).toBe(true);
    expect(result.skipped).toEqual([]);
  });

  it("emits hooks.json for resolvable approved hook suggestions only when opted in", async () => {
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([{
      id: "h1",
      name: "pre-compact-checkpoint",
      title: "Checkpoint",
      rationale: "",
      confidence: "high",
      evidence: { count: 100, sessions: 90 },
      payload: {
        type: "hook",
        event: "PreCompact",
        matcher: "compact",
        subcommand: "checkpoint",
        description: "d",
      },
    }]));
    await addEntry(dir, {
      name: "pre-compact-checkpoint",
      type: "hook",
      path: "",
      createdAt: "2026-07-01",
      suggestionId: "h1",
    });
    const result = await buildBundle(dir, "kit", { withHooks: true });
    const hooks = JSON.parse(await readFile(join(result.dir, "hooks", "hooks.json"), "utf8"));
    expect(hooks.hooks.PreCompact[0].hooks[0]).toEqual({ type: "command", command: "gradient checkpoint" });
    expect(hooks.hooks.PreCompact[0].matcher).toBe("compact");
    expect(await readFile(join(result.dir, "README.md"), "utf8")).toContain("need gradient installed");
  });

  it("skips unresolvable or unsafe hooks and ignores hooks without the flag", async () => {
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([{
      id: "unsafe",
      name: "unsafe-hook",
      title: "Unsafe",
      rationale: "",
      confidence: "high",
      evidence: { count: 3, sessions: 2 },
      payload: { type: "hook", event: "PreCompact", subcommand: "rm-rf", description: "d" },
    }]));
    await addEntry(dir, { name: "mystery-hook", type: "hook", path: "", createdAt: "2026-07-01", suggestionId: "gone" });
    await addEntry(dir, { name: "unsafe-hook", type: "hook", path: "", createdAt: "2026-07-01", suggestionId: "unsafe" });
    expect((await buildBundle(dir, "kit", { withHooks: true })).skipped.sort()).toEqual(["mystery-hook", "unsafe-hook"]);
    expect((await buildBundle(dir, "kit2")).skipped).not.toContain("mystery-hook");
  });

  it("removes a previous hooks.json when rebuilt without --with-hooks", async () => {
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([{
      id: "h1",
      name: "checkpoint",
      title: "Checkpoint",
      rationale: "",
      confidence: "high",
      evidence: { count: 3, sessions: 2 },
      payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "d" },
    }]));
    await addEntry(dir, { name: "checkpoint", type: "hook", path: "", createdAt: "2026-07-01", suggestionId: "h1" });
    const first = await buildBundle(dir, "kit", { withHooks: true });
    const hooksPath = join(first.dir, "hooks", "hooks.json");
    await expect(access(hooksPath)).resolves.toBeUndefined();
    await buildBundle(dir, "kit");
    await expect(access(hooksPath)).rejects.toThrow();
  });
});
