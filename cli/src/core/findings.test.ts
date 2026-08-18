import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFindings, type Family, type FindingsInput } from "./findings.js";
import { loadInstructions } from "./instructions.js";
import { loadSurface } from "./surface.js";
import { findStaleRefs } from "./staleness.js";
import type { Suggestion } from "./types.js";
import type { AdoptionRow } from "./adoption.js";

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-find-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: "s1",
  name: "ship-it",
  title: "Reusable workflow for “push and open a pr”",
  rationale: "Observed 6× across 4 sessions",
  evidence: { count: 6, sessions: 4 },
  confidence: "high",
  sourceSignatures: ["push and open a pr"],
  payload: { type: "command", commandName: "ship-it", body: "b" },
  ...over,
});

async function inputFor(
  dir: string,
  home: string,
  over: Partial<FindingsInput> = {},
): Promise<FindingsInput> {
  const targets = over.targets ?? (["claude-code", "codex"] as const).slice();
  const instructions = await loadInstructions(dir, targets, { home });
  return {
    projectDir: dir,
    targets,
    instructions,
    surface: await loadSurface(dir, targets, { home }),
    stale: await findStaleRefs(instructions.lines, dir),
    suggestions: [],
    adoption: [],
    ...over,
  };
}

const families = (findings: { family: Family }[]): Family[] => findings.map(f => f.family);

describe("buildFindings", () => {
  it("finds nothing in a clean project", async () => {
    const dir = await tree({ "CLAUDE.md": "# Project\n\n- Run make test before committing here\n" });
    const found = buildFindings(await inputFor(dir, await tree({})));
    expect(found).toEqual([]);
  });

  it("ranks the AGENTS.md bridge first and proposes the documented one-line fix", async () => {
    const dir = await tree({
      "AGENTS.md": "- Shared guidance for every agent in this repo\n",
      "CLAUDE.md": "- Claude-only guidance that duplicates nothing\n",
    });
    const found = buildFindings(await inputFor(dir, await tree({})));
    expect(found[0].family).toBe("drift");
    expect(found[0].severity).toBe("high");
    expect(found[0].changes).toEqual([{
      op: "prepend-import",
      path: join(dir, "CLAUDE.md"),
      assistant: "claude-code",
      after: "@AGENTS.md",
    }]);
  });

  it("does not propose the bridge once the import is there", async () => {
    const dir = await tree({
      "AGENTS.md": "- Shared guidance for every agent in this repo\n",
      "CLAUDE.md": "@AGENTS.md\n\n- Claude-only extras go below the import\n",
    });
    expect(families(buildFindings(await inputFor(dir, await tree({}))))).not.toContain("drift");
  });

  it("does not propose the bridge when only one assistant is a target", async () => {
    const dir = await tree({
      "AGENTS.md": "- Shared guidance for every agent in this repo\n",
      "CLAUDE.md": "- Claude-only guidance that duplicates nothing\n",
    });
    const found = buildFindings(await inputFor(dir, await tree({}), { targets: ["claude-code"] }));
    expect(families(found)).not.toContain("drift");
  });

  it("reports an instruction whose reference the repository lost, with the line to delete", async () => {
    const dir = await tree({
      "CLAUDE.md": "- Build the project with `scripts/build.sh` first\n",
      "package.json": JSON.stringify({ scripts: {} }),
    });
    const [found] = buildFindings(await inputFor(dir, await tree({})));
    expect(found.family).toBe("stale");
    expect(found.changes[0]).toMatchObject({ op: "delete-line", line: 1 });
    expect(found.detail).toContain("scripts/build.sh");
  });

  it("separates a skill that cannot load from one that merely will not be picked", async () => {
    const home = await tree({});
    // Unterminated frontmatter is the only case that genuinely stops a load.
    const broken = await tree({
      ".claude/skills/a/SKILL.md": "---\nname: a\ndescription: d\nBody with no close\n",
    });
    const [blocking] = buildFindings(await inputFor(broken, home));
    expect(blocking.severity).toBe("high");
    expect(blocking.title).toContain("will not load");

    // A non-standard key is a portability problem, never a high-severity one.
    const nonStandard = await tree({
      ".claude/skills/c/SKILL.md": "---\nname: c\ndescription: d\nversion: 1.0.0\n---\nBody\n",
    });
    const [portability] = buildFindings(await inputFor(nonStandard, home));
    expect(portability.severity).toBe("medium");
    expect(portability.detail).toContain("Agent Skills spec");
    // The severity was already right; the headline was not. An extra key does
    // not affect selection at all, and "unlikely to be selected" is the same
    // false alarm the severity was lowered to avoid — moved into the one line
    // most readers actually read.
    expect(portability.title).not.toContain("unlikely to be selected");
    expect(portability.title).toContain("frontmatter outside the spec");
    // Evidence must cite the thing the finding is about. Reporting a healthy
    // description length as the evidence for a key problem points the reader
    // at the wrong number to fix.
    expect(portability.evidence).toContain("version");
    expect(portability.evidence).not.toContain("description chars");

    // Two offending keys, one explanation. The per-problem map repeated the
    // whole 30-word sentence once per key.
    const twoKeys = await tree({
      ".claude/skills/d/SKILL.md": "---\nname: d\ndescription: d\nversion: 1.0.0\nrequires: x\n---\nBody\n",
    });
    const [grouped] = buildFindings(await inputFor(twoKeys, home));
    expect(grouped.detail).toContain("`version` and `requires` are outside");
    expect(grouped.detail.match(/Agent Skills spec/g)).toHaveLength(1);

    const vague = await tree({
      ".claude/skills/b/SKILL.md": `---\nname: b\ndescription: ${"y".repeat(2000)}\n---\nBody\n`,
    });
    const [soft] = buildFindings(await inputFor(vague, home));
    expect(soft.severity).toBe("medium");
    expect(soft.title).toContain("unlikely to be selected");
    // A description problem is the case where the char count IS the evidence.
    expect(soft.evidence).toContain("description chars");
  });

  it("proposes deleting a generated skill nothing has ever invoked", async () => {
    const dir = await tree({
      ".claude/skills/ship-it/SKILL.md": "---\nname: ship-it\ndescription: Ship the thing\n---\n<!-- gradient:generated id=1 name=ship-it -->\nBody\n",
    });
    const adoption: AdoptionRow[] = [{
      name: "ship-it", type: "skill", createdAt: "2026-01-01",
      uses: 0, realizedMinutesSaved: 0, suggestRemoval: true,
    }];
    const found = buildFindings(await inputFor(dir, await tree({}), { adoption }));
    const unused = found.find(f => f.title.includes("never been invoked"));
    expect(unused?.changes[0]).toMatchObject({ op: "delete-file", path: join(dir, ".claude/skills/ship-it/SKILL.md") });
  });

  // The one thing neither assistant can tell you about your own instructions.
  it("reports an instruction the user keeps retyping instead of proposing a duplicate skill", async () => {
    const dir = await tree({ "CLAUDE.md": "- push and open a pr when the work is done\n" });
    const found = buildFindings(await inputFor(dir, await tree({}), {
      suggestions: [suggestion()],
    }));
    expect(families(found)).toContain("dead-letter");
    // The same habit must not also arrive as a fresh workflow proposal.
    expect(families(found)).not.toContain("workflow");
    const deadLetter = found.find(f => f.family === "dead-letter")!;
    expect(deadLetter.detail).toContain("6 times across 4 sessions");
  });

  // A hook is event-derived by construction, so it must never be labelled as
  // inferred from prompts — the dogfood report called the checkpoint hook,
  // counted from 16 /compact invocations, "inferred from repeated prompts".
  it("labels an event-derived hook as counted, not inferred", async () => {
    const dir = await tree({ "CLAUDE.md": "- unrelated guidance for this repo\n" });
    const hook = suggestion({
      id: "h1", name: "checkpoint-before-compaction",
      title: "Save a checkpoint before context compaction",
      sourceSignatures: ["/compact"],
      payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "d" },
    });
    const found = buildFindings(await inputFor(dir, await tree({}), { suggestions: [hook] }));
    const workflow = found.find(f => f.family === "workflow")!;
    expect(workflow.evidence).toContain("counted from tool events");
    expect(workflow.severity).toBe("medium");
  });

  it("keeps a mined workflow that no written instruction covers", async () => {
    const dir = await tree({ "CLAUDE.md": "- Prefer named exports throughout this codebase\n" });
    const found = buildFindings(await inputFor(dir, await tree({}), { suggestions: [suggestion()] }));
    const workflow = found.find(f => f.family === "workflow");
    expect(workflow?.suggestion?.id).toBe("s1");
    expect(families(found)).not.toContain("dead-letter");
  });

  it("flags an instruction file past the documented length target", async () => {
    const long = ["# Project", ...Array.from({ length: 210 }, (_, i) => `- Instruction number ${i} for this repo`)].join("\n");
    const dir = await tree({ "CLAUDE.md": long });
    const found = buildFindings(await inputFor(dir, await tree({})));
    const practice = found.find(f => f.family === "practice");
    expect(practice?.title).toContain("211 lines");
  });

  it("flags the same instruction written into two files that both load", async () => {
    const dir = await tree({
      "CLAUDE.md": "- Always run the full test suite before committing\n",
      ".claude/rules/testing.md": "- Always run the full test suite before committing\n",
    });
    const found = buildFindings(await inputFor(dir, await tree({})));
    const duplicate = found.find(f => f.title.includes("more than one loaded file"));
    expect(duplicate).toBeDefined();
    expect(duplicate!.evidence).toContain("CLAUDE.md:1");
  });

  it("reports an oversized memory index and never proposes a change inside it", async () => {
    const dir = await tree({});
    const encoded = dir.replace(/\//g, "-");
    const home = await tree({
      [`.claude/projects/${encoded}/memory/MEMORY.md`]:
        ["# Memory", ...Array.from({ length: 240 }, (_, i) => `- remembered fact number ${i}`)].join("\n"),
    });
    const found = buildFindings(await inputFor(dir, home));
    const memory = found.find(f => f.family === "memory")!;
    expect(memory.title).toContain("past the size Claude Code loads");
    expect(found.flatMap(f => f.changes).some(change => change.path.includes("/memory/"))).toBe(false);
  });

  it("gives a finding the same id across runs so a denial can stick", async () => {
    const dir = await tree({ "CLAUDE.md": "- Build the project with `scripts/build.sh` first\n" });
    const first = buildFindings(await inputFor(dir, await tree({})));
    const second = buildFindings(await inputFor(dir, await tree({})));
    expect(first.map(f => f.id)).toEqual(second.map(f => f.id));
  });

  it("sorts high severity before low and never repeats an id", async () => {
    const dir = await tree({
      "AGENTS.md": "- Shared guidance for every agent in this repo\n",
      "CLAUDE.md": ["# P", ...Array.from({ length: 210 }, (_, i) => `- Instruction number ${i} for this repo`)].join("\n"),
    });
    const found = buildFindings(await inputFor(dir, await tree({})));
    expect(found[0].severity).toBe("high");
    expect(new Set(found.map(f => f.id)).size).toBe(found.length);
  });
});
