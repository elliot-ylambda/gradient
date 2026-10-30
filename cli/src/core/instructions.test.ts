import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  extractLines,
  importsAgentsMd,
  loadInstructions,
  type InstructionSource,
} from "./instructions.js";

const source: InstructionSource = {
  path: "/p/CLAUDE.md", scope: "project", assistant: "claude-code",
  kind: "claude-md", lineCount: 1, bytes: 1,
};

async function project(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "grad-instr-")));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

describe("extractLines", () => {
  it("takes list items and short paragraphs, and skips structure", () => {
    const out = extractLines([
      "# Heading that is long enough to pass the length floor",
      "",
      "- Always run the test suite before committing",
      "1. Prefer pnpm over npm in this repository",
      "Use two-space indentation everywhere in this project",
      "",
      "| a | b |",
      "---",
      "<!-- gradient:generated id=1 name=x -->",
      "[a link](https://example.com/somewhere/long)",
      "short",
    ].join("\n"), source);
    expect(out.map(line => line.text)).toEqual([
      "Always run the test suite before committing",
      "Prefer pnpm over npm in this repository",
      "Use two-space indentation everywhere in this project",
    ]);
  });

  it("never reads inside a fenced block", () => {
    const out = extractLines([
      "- A real instruction that is long enough",
      "```bash",
      "- this looks like an instruction but is sample output",
      "```",
      "~~~",
      "- and so does this one, in a tilde fence",
      "~~~",
    ].join("\n"), source);
    expect(out.map(line => line.text)).toEqual(["A real instruction that is long enough"]);
  });

  it("reports 1-based line numbers past frontmatter", () => {
    const out = extractLines([
      "---",
      "paths:",
      "  - src/**/*.ts",
      "---",
      "",
      "- Validate every API input at the boundary",
    ].join("\n"), source);
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(6);
  });

  it("drops lines outside the 8-200 character window", () => {
    const out = extractLines(["- tiny", `- ${"x".repeat(300)}`].join("\n"), source);
    expect(out).toEqual([]);
  });
});

describe("importsAgentsMd", () => {
  it("finds a real import and ignores a backticked mention", () => {
    expect(importsAgentsMd("@AGENTS.md\n\n# Rest")).toBe(true);
    expect(importsAgentsMd("See @./AGENTS.md for shared rules")).toBe(true);
    // Documented: a backticked @path stays literal, so this repo is NOT bridged
    // and must still be offered the bridge.
    expect(importsAgentsMd("Write `@AGENTS.md` to import the file")).toBe(false);
    expect(importsAgentsMd("```\n@AGENTS.md\n```")).toBe(false);
    expect(importsAgentsMd("# No import here at all")).toBe(false);
  });
});

describe("loadInstructions", () => {
  it("reads every documented Claude Code source, including the rules directories", async () => {
    const home = await project({
      ".claude/CLAUDE.md": "- A personal preference that is long enough\n",
      ".claude/rules/style.md": "- Prefer named exports across the codebase\n",
      ".claude/rules/nested/deep.md": "- Nested rules are discovered recursively\n",
    });
    const dir = await project({
      "CLAUDE.md": "- Run make test before every commit here\n",
      ".claude/CLAUDE.md": "- The dot-claude project file also loads\n",
      "CLAUDE.local.md": "- Local overrides load alongside the project file\n",
      ".claude/rules/api.md": "---\npaths:\n  - src/api/**\n---\n- Validate every API input at the boundary\n",
    });
    const set = await loadInstructions(dir, ["claude-code"], { home });
    expect(set.sources.map(s => s.kind).sort()).toEqual(
      ["claude-local", "claude-md", "claude-md", "claude-md", "rule", "rule", "rule"],
    );
    expect(set.lines).toHaveLength(7);
    const scoped = set.sources.find(s => s.path.endsWith("api.md"));
    expect(scoped?.pathScoped).toBe(true);
    const unscoped = set.sources.find(s => s.path.endsWith("style.md"));
    expect(unscoped?.pathScoped).toBe(false);
  });

  it("reads Codex sources only when Codex is a target", async () => {
    const home = await project({ ".codex/AGENTS.md": "- A global Codex convention worth keeping\n" });
    const dir = await project({
      "AGENTS.md": "- Repository-wide agent guidance lives here\n",
      "CLAUDE.md": "- Claude-specific guidance lives here\n",
    });

    const claudeOnly = await loadInstructions(dir, ["claude-code"], { home });
    expect(claudeOnly.sources.some(s => s.kind === "agents-md")).toBe(false);

    const both = await loadInstructions(dir, ["claude-code", "codex"], { home });
    expect(both.sources.filter(s => s.kind === "agents-md")).toHaveLength(2);
  });

  it("reports bridge state for each of the documented arrangements", async () => {
    const home = await project({});

    const neither = await loadInstructions(await project({}), ["claude-code", "codex"], { home });
    expect(neither.bridge).toMatchObject({ agentsMdExists: false, claudeMdExists: false, importsAgentsMd: false });

    const unbridged = await loadInstructions(
      await project({ "AGENTS.md": "- shared\n", "CLAUDE.md": "- claude only\n" }),
      ["claude-code", "codex"], { home },
    );
    expect(unbridged.bridge).toMatchObject({ agentsMdExists: true, claudeMdExists: true, importsAgentsMd: false });

    const bridged = await loadInstructions(
      await project({ "AGENTS.md": "- shared\n", "CLAUDE.md": "@AGENTS.md\n" }),
      ["claude-code", "codex"], { home },
    );
    expect(bridged.bridge.importsAgentsMd).toBe(true);
  });

  it("detects the symlink arrangement", async () => {
    const dir = await project({ "AGENTS.md": "- shared guidance for both assistants\n" });
    await symlink(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"));
    const set = await loadInstructions(dir, ["claude-code", "codex"], { home: await project({}) });
    expect(set.bridge.symlinked).toBe(true);
    expect(set.unreadable).toEqual([]);
    expect(set.sources.some(s => s.assistant === "claude-code" && s.path.endsWith("CLAUDE.md"))).toBe(true);
  });

  it("uses current Claude AGENTS fallback, with no invented missing bridge", async () => {
    const dir = await project({ "AGENTS.md": "- Shared guidance for both assistants\n" });
    const set = await loadInstructions(dir, ["claude-code", "codex"], { home: await project({}) });
    expect(set.bridge.claudeLoadsAgentsMd).toBe(true);
    expect(set.sources.filter(s => s.path === join(dir, "AGENTS.md")).map(s => s.assistant).sort()).toEqual(["claude-code", "codex"]);
  });

  it("honors user instruction mode and ignores project-local copies of that setting", async () => {
    const both = { pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } } } };
    const dir = await project({ "AGENTS.md": "- Shared guidance for both assistants\n", "CLAUDE.local.md": "- Local guidance blocks the native fallback\n", ".claude/settings.json": JSON.stringify(both) });
    const home = await project({});
    expect((await loadInstructions(dir, ["claude-code"], { home })).bridge.claudeLoadsAgentsMd).toBe(false);
    const claudeHome = await project({ "settings.json": JSON.stringify(both) });
    const loaded = await loadInstructions(dir, ["claude-code"], { home, claudeHome });
    expect(loaded.bridge).toMatchObject({ mode: "claude-md-and-agents-md", claudeLoadsAgentsMd: true });
    await writeFile(join(claudeHome, "settings.json"), JSON.stringify({ pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "managed-only" } } } }));
    expect((await loadInstructions(dir, ["claude-code"], { home, claudeHome })).sources).toEqual([]);
  });

  it("reads ancestor instructions and respects Codex override precedence and custom homes", async () => {
    const dir = await project({ "AGENTS.md": "- Superseded repository instructions here\n", "AGENTS.override.md": "- Repository override actually wins here\n", "CLAUDE.md": "- Parent Claude instructions block fallback\n", "packages/api/AGENTS.md": "- Nested agent instructions apply here\n" });
    execFileSync("git", ["init", "-q", dir]);
    const codexHome = await project({ "AGENTS.md": "- Superseded global instructions here\n", "AGENTS.override.md": "- Global override actually wins here\n" });
    const set = await loadInstructions(join(dir, "packages", "api"), ["claude-code", "codex"], { home: await project({}), codexHome });
    expect(set.sources.filter(s => s.assistant === "codex").map(s => s.path)).toEqual([
      join(codexHome, "AGENTS.override.md"), join(dir, "AGENTS.override.md"), join(dir, "packages", "api", "AGENTS.md"),
    ]);
    expect(set.bridge.blockedBy).toContain(join(dir, "CLAUDE.md"));
    expect(set.bridge.claudeLoadsAgentsMd).toBe(false);
  });

  it("inspects actual imported guidance once, and reports missing imports", async () => {
    const dir = await project({ "CLAUDE.md": "@AGENTS.md\n@missing.md\n", "AGENTS.md": "- Shared instructions should be inspected\n" });
    const set = await loadInstructions(dir, ["claude-code"], { home: await project({}) });
    expect(set.bridge.claudeLoadsAgentsMd).toBe(true);
    expect(set.sources.filter(s => s.path.endsWith("AGENTS.md"))).toHaveLength(1);
    expect(set.unreadable).toContain(join(dir, "missing.md"));
  });

  it("keeps imported assistant memory read-only, including a configured directory behind a symlink", async () => {
    const memory = await project({ "notes.md": "- Run scripts/deleted-build.sh before release\n" });
    const home = await project({
      ".claude/settings.json": JSON.stringify({ autoMemoryDirectory: memory }),
      ".claude/projects/example/memory/MEMORY.md": "- Run scripts/deleted-build.sh before release\n",
      ".codex/memories/MEMORY.md": "- Run scripts/deleted-build.sh before release\n",
    });
    // The user's own instructions may import anything they own.
    await writeFile(join(home, ".claude/CLAUDE.md"),
      `@${join(home, ".claude/projects/example/memory/MEMORY.md")}\n@${join(home, ".codex/memories/MEMORY.md")}\n@${join(home, "linked-notes.md")}\n`);
    await symlink(join(memory, "notes.md"), join(home, "linked-notes.md"));
    const dir = await project({ "CLAUDE.md": "@notes.md\n", "notes.md": "- Run scripts/deleted-build.sh before release\n" });
    const result = await loadInstructions(dir, ["claude-code"], { home });
    expect(result.sources.filter(source => source.readOnly).map(source => source.path).sort()).toEqual([
      join(home, ".claude/projects/example/memory/MEMORY.md"),
      join(home, ".codex/memories/MEMORY.md"),
      join(home, "linked-notes.md"),
    ].sort());
    expect(result.sources.find(source => source.path === join(dir, "notes.md"))?.readOnly).toBeUndefined();
    expect(result.lines.some(line => line.source.readOnly && line.text.includes("deleted-build.sh"))).toBe(true);
  });

  /** A cloned repository decides what its own files say, never which of the
   *  user's files gradient reads into findings. Claude Code asks first, too. */
  it("does not follow a repository's import or link out of the repository", async () => {
    const home = await project({ "secret.md": "- token: do-not-read\n" });
    const outside = await project({ "rule.md": "- outside rule do-not-read\n" });
    const dir = await project({
      "CLAUDE.md": `@${join(home, "secret.md")}\n@~/secret.md\n- Keep this line.\n`,
      ".claude/rules/kept.md": "- In-repo rule\n",
    });
    await symlink(join(home, "secret.md"), join(dir, ".claude/rules/linked.md"));
    await symlink(outside, join(dir, ".claude/rules/linked-dir"));
    const result = await loadInstructions(dir, ["claude-code"], { home });
    expect(result.lines.map(line => line.text).join("\n")).not.toContain("do-not-read");
    expect(result.lines.some(line => line.text.includes("Keep this line"))).toBe(true);
    expect(result.lines.some(line => line.text.includes("In-repo rule"))).toBe(true);
    // Both imports name one file, so they share one warning.
    expect(result.warnings?.filter(warning => warning.includes("outside the repository")).length).toBe(3);
  });

  it("reports a Codex instruction byte limit instead of auditing truncated guidance as fully loaded", async () => {
    const home = await project({ ".codex/config.toml": "project_doc_max_bytes = 12\n" });
    const dir = await project({ "AGENTS.md": "- More than twelve bytes of instructions\n" });
    const set = await loadInstructions(dir, ["codex"], { home });
    expect(set.sources).toEqual([]);
    expect(set.codexBudget).toEqual({ path: join(dir, "AGENTS.md"), bytes: 41, budget: 12, loaded: 12 });
  });

  it("is a no-op on a project with no instruction files at all", async () => {
    const set = await loadInstructions(await project({}), ["claude-code", "codex"], { home: await project({}) });
    expect(set.sources).toEqual([]);
    expect(set.lines).toEqual([]);
    expect(set.unreadable).toEqual([]);
  });
});
