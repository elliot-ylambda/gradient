import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESCRIPTION_CAP,
  MEMORY_INDEX_MAX_LINES,
  loadMemory,
  loadSurface,
  type SkillProblem,
} from "./surface.js";

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "grad-surface-")));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

const skill = (description: string, extra = ""): string =>
  `---\nname: x\ndescription: ${JSON.stringify(description)}\n${extra}---\nBody text.\n`;

const kinds = (problems: SkillProblem[]): string[] => problems.map(p => p.kind).sort();

describe("loadSurface", () => {
  it("finds skills for both assistants and totals the context they cost", async () => {
    const home = await tree({
      ".claude/skills/personal/SKILL.md": skill("A personal skill"),
      ".agents/skills/shared/SKILL.md": skill("A codex skill"),
    });
    const dir = await tree({
      ".claude/skills/project/SKILL.md": skill("A project skill"),
      ".claude/commands/legacy.md": skill("A legacy command file"),
    });
    const surface = await loadSurface(dir, ["claude-code", "codex"], { home });
    expect(surface.skills.map(s => s.name).sort()).toEqual(["legacy", "personal", "project", "shared"]);
    expect(surface.contextChars).toBe(
      "A personal skill".length + "A codex skill".length +
      "A project skill".length + "A legacy command file".length,
    );
  });

  it("reads only the assistants asked for", async () => {
    const home = await tree({ ".agents/skills/shared/SKILL.md": skill("A codex skill") });
    const surface = await loadSurface(await tree({}), ["claude-code"], { home });
    expect(surface.skills).toEqual([]);
  });

  // Claude Code tolerates extra keys — a real installed skill carrying
  // `version:` and `requires:` loads fine — so this is a portability finding,
  // not a "this is broken" one.
  it("flags a key that no tool documents as a portability problem", async () => {
    const dir = await tree({ ".claude/skills/bad/SKILL.md": skill("ok", "version: 0.38.0\n") });
    const [found] = (await loadSurface(dir, ["claude-code"], { home: await tree({}) })).skills;
    expect(kinds(found.problems)).toEqual(["non-standard-key"]);
    expect(found.problems[0]).toMatchObject({ kind: "non-standard-key", key: "version" });
  });

  it("accepts every documented Claude Code key without complaint", async () => {
    const dir = await tree({
      ".claude/skills/rich/SKILL.md": skill("ok", "model: haiku\neffort: low\npaths: src/**\ncontext: fork\n"),
    });
    const [found] = (await loadSurface(dir, ["claude-code"], { home: await tree({}) })).skills;
    expect(found.problems).toEqual([]);
  });

  // The bridge case in miniature: a Claude-Code-only key in a skill installed
  // for Codex is exactly why it does nothing there.
  it("flags a Claude-Code-only key on a skill installed for Codex", async () => {
    const home = await tree({ ".agents/skills/x/SKILL.md": skill("ok", "when_to_use: sometimes\n") });
    const [found] = (await loadSurface(await tree({}), ["codex"], { home })).skills;
    expect(kinds(found.problems)).toEqual(["non-portable-key"]);
  });

  it("uses Claude's body description fallback and flags its listing cap", async () => {
    const home = await tree({});
    const missing = await tree({ ".claude/skills/a/SKILL.md": "---\nname: a\n---\nBody.\n" });
    const fallback = (await loadSurface(missing, ["claude-code"], { home })).skills[0];
    expect(fallback.problems).toEqual([]);
    expect(fallback.description).toBe("Body.");

    const long = await tree({ ".claude/skills/b/SKILL.md": skill("y".repeat(DESCRIPTION_CAP + 1)) });
    const [found] = (await loadSurface(long, ["claude-code"], { home })).skills;
    expect(found.problems[0]).toMatchObject({ kind: "description-over-cap" });
  });

  it("inspects installer destinations, ancestor skills, and custom Codex homes", async () => {
    const home = await tree({ ".codex/skills/installed/SKILL.md": "---\nname: installed\n---\nBody.\n" });
    const dir = await tree({ ".agents/skills/team/SKILL.md": skill("Team review workflow"), "nested/.agents/skills/package/SKILL.md": skill("Package-specific workflow") });
    execFileSync("git", ["init", "-q", dir]);
    const regular = await loadSurface(join(dir, "nested"), ["codex"], { home });
    expect(regular.skills.map(s => s.name).sort()).toEqual(["installed", "package", "team"]);
    expect(regular.skills.find(s => s.name === "installed")?.problems).toContainEqual({ kind: "no-description" });
    const codexHome = await tree({ "skills/custom/SKILL.md": skill("Custom location workflow") });
    const custom = await loadSurface(join(dir, "nested"), ["codex"], { home, codexHome });
    expect(custom.skills.map(s => s.name).sort()).toEqual(["custom", "package", "team"]);
  });

  it("reads only enabled applicable Claude plugin installations and namespaces their skills", async () => {
    const plugin = await tree({ ".claude-plugin/plugin.json": JSON.stringify({ name: "reviewer" }), "skills/review/SKILL.md": skill("Review changed code carefully") });
    const unused = await tree({ "skills/old/SKILL.md": skill("Old cached version should not load") });
    const claudeHome = await tree({
      "settings.json": JSON.stringify({ enabledPlugins: { "reviewer@test": true, "disabled@test": false, "elsewhere@test": true } }),
      "plugins/installed_plugins.json": JSON.stringify({ version: 2, plugins: {
        "reviewer@test": [{ scope: "user", installPath: plugin }],
        "disabled@test": [{ scope: "user", installPath: unused }],
        "elsewhere@test": [{ scope: "project", projectPath: "/unrelated", installPath: unused }],
      } }),
    });
    const result = await loadSurface(await tree({}), ["claude-code"], { home: await tree({}), claudeHome });
    expect(result.skills.map(s => s.name)).toEqual(["reviewer:review"]);
    expect(result.warnings?.join("\n")).toContain("elsewhere@test has no applicable installation");
  });

  it("follows named skill symlinks once and honors disabled skills", async () => {
    const home = await tree({ ".agents/skills/shared/SKILL.md": skill("A shared symlinked workflow"), ".codex/config.toml": "" });
    await mkdir(join(home, ".codex", "skills"), { recursive: true });
    await symlink(join(home, ".agents", "skills", "shared"), join(home, ".codex", "skills", "linked"));
    const dir = await tree({});
    expect((await loadSurface(dir, ["codex"], { home })).skills).toHaveLength(1);
    await writeFile(join(home, ".codex", "config.toml"), `[[skills.config]]\npath = ${JSON.stringify(join(home, ".agents", "skills", "shared", "SKILL.md"))}\nenabled = false\n`);
    const disabled = await loadSurface(dir, ["codex"], { home });
    expect(disabled.skills).toEqual([]);
  });

  /** A user's own skill links are theirs to make; a repository's are not. */
  it("does not inventory a repository skill that links out of the repository", async () => {
    const home = await tree({ "private/SKILL.md": skill("Private workflow do-not-read") });
    const dir = await tree({ ".claude/skills/kept/SKILL.md": skill("An in-repository workflow") });
    await symlink(join(home, "private"), join(dir, ".claude", "skills", "linked"));
    const other = await tree({});
    await mkdir(join(other, ".agents"), { recursive: true });
    await symlink(join(home), join(other, ".agents", "skills"));
    const claude = await loadSurface(dir, ["claude-code"], { home });
    expect(claude.skills.map(found => found.description)).toEqual(["An in-repository workflow"]);
    expect(claude.warnings?.some(warning => warning.includes("outside the repository"))).toBe(true);
    // The repository's own `.agents/skills` directory may itself be the link.
    expect((await loadSurface(other, ["codex"], { home: await tree({}) })).skills).toEqual([]);
  });

  it("uses a configured memory directory and honors memory being disabled", async () => {
    const memory = await tree({ "MEMORY.md": "# Memory\n- A useful project preference\n" });
    const home = await tree({ ".claude/settings.json": JSON.stringify({ autoMemoryDirectory: memory }) });
    const dir = await tree({});
    expect((await loadSurface(dir, ["claude-code"], { home })).memory?.indexPath).toBe(join(memory, "MEMORY.md"));
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ autoMemoryDirectory: memory, autoMemoryEnabled: false }));
    expect((await loadSurface(dir, ["claude-code"], { home })).memory).toBeNull();
  });

  it("flags two skills the model could not tell apart, but not the same skill on both assistants", async () => {
    const home = await tree({});
    const duplicated = await tree({
      ".claude/skills/one/SKILL.md": skill("Review the diff and flag risky changes"),
      ".claude/skills/two/SKILL.md": skill("Review the diff and flag risky changes"),
    });
    const surface = await loadSurface(duplicated, ["claude-code"], { home });
    expect(surface.skills.every(s => kinds(s.problems).includes("duplicate-description"))).toBe(true);

    const crossAssistant = await tree({
      ".claude/skills/one/SKILL.md": skill("Review the diff and flag risky changes"),
      ".agents/skills/one/SKILL.md": skill("Review the diff and flag risky changes"),
    });
    const both = await loadSurface(crossAssistant, ["claude-code", "codex"], { home });
    expect(both.skills.every(s => s.problems.length === 0)).toBe(true);
  });

  it("reports unreadable frontmatter rather than pretending the file is fine", async () => {
    const dir = await tree({ ".claude/skills/broken/SKILL.md": "---\nname: x\ndescription: ok\nBody with no close\n" });
    const [found] = (await loadSurface(dir, ["claude-code"], { home: await tree({}) })).skills;
    expect(kinds(found.problems)).toContain("unreadable-frontmatter");
  });

  it("marks gradient's own artifacts as owned", async () => {
    const dir = await tree({
      ".claude/skills/mine/SKILL.md": `---\nname: mine\ndescription: d\n---\n<!-- gradient:generated id=1 name=mine -->\nBody\n`,
      ".claude/skills/theirs/SKILL.md": skill("Hand written"),
    });
    const surface = await loadSurface(dir, ["claude-code"], { home: await tree({}) });
    expect(surface.skills.find(s => s.name === "mine")?.gradientOwned).toBe(true);
    expect(surface.skills.find(s => s.name === "theirs")?.gradientOwned).toBe(false);
  });
});

describe("loadMemory", () => {
  it("returns null when the project has no auto-memory index", async () => {
    expect(await loadMemory(await tree({}), await tree({}))).toBeNull();
  });

  it("marks entries past the load limit and never writes to the directory", async () => {
    const project = await tree({});
    const encoded = project.replace(/\//g, "-");
    const body = [
      "# Memory index",
      ...Array.from({ length: MEMORY_INDEX_MAX_LINES + 5 }, (_, i) => `- entry number ${i}`),
    ].join("\n");
    const home = await tree({ [`.claude/projects/${encoded}/memory/MEMORY.md`]: body });

    const memory = await loadMemory(project, home);
    expect(memory).not.toBeNull();
    expect(memory!.overLineLimit).toBe(true);
    expect(memory!.lines.filter(line => line.beyondLimit).length).toBeGreaterThan(0);
    expect(memory!.lines[0].beyondLimit).toBe(false);
    expect(memory!.lines[0].text).toBe("entry number 0");
  });

  it("reports a comfortable index as within its limits", async () => {
    const project = await tree({});
    const encoded = project.replace(/\//g, "-");
    const home = await tree({
      [`.claude/projects/${encoded}/memory/MEMORY.md`]: "# Memory index\n\n- one short entry\n",
    });
    const memory = await loadMemory(project, home);
    expect(memory!.overLineLimit).toBe(false);
    expect(memory!.overByteLimit).toBe(false);
    expect(memory!.lines).toHaveLength(1);
  });
});
