import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const dir = await mkdtemp(join(tmpdir(), "grad-instr-"));
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
    // The symlink is refused as a read target, so it is reported rather than
    // silently treated as an absent file.
    expect(set.unreadable).toContain(join(dir, "CLAUDE.md"));
  });

  it("is a no-op on a project with no instruction files at all", async () => {
    const set = await loadInstructions(await project({}), ["claude-code", "codex"], { home: await project({}) });
    expect(set.sources).toEqual([]);
    expect(set.lines).toEqual([]);
    expect(set.unreadable).toEqual([]);
  });
});
