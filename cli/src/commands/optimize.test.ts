import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOrder, autoEligible, optimize, optimizeJson } from "./optimize.js";
import { loadResult } from "../core/run.js";
import type { Finding } from "../core/findings.js";
import type { Suggestion } from "../core/types.js";
import { FEATURES } from "./features.js";

async function tree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-opt-"));
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
  payload: { type: "command", commandName: "ship-it", body: "Body." },
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1", family: "stale", severity: "high", title: "t", detail: "d", evidence: "e",
  targets: ["claude-code"], deterministic: true, commandBearing: false, changes: [],
  ...over,
});

describe("optimize", () => {
  // gradient arrives as a plugin or a copied skill directory, so it installs no
  // skill of its own — the only first-run state is which assistants to read.
  it("asks for targets once and remembers the answer", async () => {
    const home = await tree({});
    const dir = await tree({ "CLAUDE.md": "- a rule that is perfectly current\n" });

    const result = await optimize(dir, { home }, { suggestions: [], ask: async () => "both" });
    expect(result.targets).toEqual(["claude-code", "codex"]);

    const again = await optimize(dir, { home }, {
      suggestions: [],
      ask: async () => { throw new Error("should not ask"); },
    });
    expect(again.targets).toEqual(["claude-code", "codex"]);
  });

  it("finds the bridge, the stale line, and the mined workflow in one list", async () => {
    const home = await tree({});
    const dir = await tree({
      "AGENTS.md": "- shared guidance for both assistants here\n",
      "CLAUDE.md": "- Build it with `scripts/build.sh` before committing\n",
      "package.json": JSON.stringify({ scripts: {} }),
    });
    const result = await optimize(dir, { target: "both", home }, { suggestions: [suggestion()] });
    const families = result.findings.map(f => f.family);
    expect(families).toContain("drift");
    expect(families).toContain("stale");
    expect(families).toContain("workflow");
    // Highest severity first.
    expect(result.findings[0].severity).toBe("high");
  });

  it("applies only the ids it was given", async () => {
    const home = await tree({});
    const dir = await tree({
      "AGENTS.md": "- shared guidance for both assistants here\n",
      "CLAUDE.md": "- a rule that is perfectly current\n",
    });
    const proposed = await optimize(dir, { target: "both", home }, { suggestions: [] });
    const bridge = proposed.findings.find(f => f.family === "drift")!;

    const applied = await optimize(dir, { target: "both", home, apply: [bridge.id] }, { suggestions: [] });
    expect(applied.applied.map(a => a.id)).toEqual([bridge.id]);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toMatch(/^@AGENTS\.md/);
    expect(applied.runId).toBeDefined();

    const result = await loadResult(applied.runId!, home);
    expect(result?.applied[0].paths).toEqual([join(dir, "CLAUDE.md")]);
  });

  it("does nothing and names no run when no id matches", async () => {
    const home = await tree({});
    const dir = await tree({ "CLAUDE.md": "- a rule that is perfectly current\n" });
    const result = await optimize(dir, { target: "claude-code", home, apply: ["nope"] }, { suggestions: [] });
    expect(result.applied).toEqual([]);
    expect(result.runId).toBeUndefined();
  });

  it("says an id no longer matches rather than reporting a silent success", async () => {
    const home = await tree({});
    const dir = await tree({
      "AGENTS.md": "- shared guidance for both assistants here\n",
      "CLAUDE.md": "- Build it with `scripts/build.sh` before committing\n",
    });
    const proposed = await optimize(dir, { target: "both", home }, { suggestions: [] });
    const stale = proposed.findings.find(f => f.family === "stale")!;
    // The file moves out from under the finding.
    await writeFile(join(dir, "CLAUDE.md"), "- something else entirely now\n");

    const applied = await optimize(dir, { target: "both", home, apply: [stale.id] }, {
      suggestions: [],
    });
    expect(applied.applied).toEqual([]);
    expect(applied.skipped[0]).toMatchObject({ id: stale.id });
    expect(applied.skipped[0].reason).toMatch(/no current finding has this id/);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe("- something else entirely now\n");
  });

  it("--auto takes the bridge and leaves prose edits alone", async () => {
    const home = await tree({});
    const dir = await tree({
      "AGENTS.md": "- shared guidance for both assistants here\n",
      "CLAUDE.md": "- Build it with `scripts/build.sh` before committing\n",
    });
    const result = await optimize(dir, { target: "both", home, auto: true }, { suggestions: [] });

    const appliedFamilies = result.applied.map(entry =>
      result.findings.find(f => f.id === entry.id)?.family);
    expect(appliedFamilies).toEqual(["drift"]);
    // The stale line is still there: --auto never edits hand-written prose.
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toContain("scripts/build.sh");
  });

  // Found by running the packed binary as a new user would: the bridge and a
  // stale line both live in CLAUDE.md, and adding the import moved the stale
  // line out from under its own line number. The apply the CLI prints for
  // itself half-worked.
  it("applies two findings in one file without one invalidating the other", async () => {
    const home = await tree({});
    const dir = await tree({
      "AGENTS.md": "Use pnpm, not npm.\n",
      "CLAUDE.md": "# Project\n\n- Build with `scripts/build.sh` before every commit.\n",
    });

    const proposed = await optimize(dir, { home, target: "both" }, {
      suggestions: [],
    });
    const ids = proposed.findings.map(f => f.id);
    expect(proposed.findings.map(f => f.family).sort()).toEqual(["drift", "stale"]);

    const result = await optimize(dir, { home, apply: ids }, {
      suggestions: [],
    });

    expect(result.skipped).toEqual([]);
    expect(result.applied).toHaveLength(2);
    const after = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(after.startsWith("@AGENTS.md\n")).toBe(true);
    expect(after).not.toContain("scripts/build.sh");
  });
});

describe("applyOrder", () => {
  const at = (line: number, id: string): Finding =>
    finding({ id, changes: [{ op: "delete-line", path: "/p/CLAUDE.md", assistant: "claude-code", line }] });

  it("takes later lines first, so an earlier edit cannot move a later one", () => {
    expect(applyOrder([at(3, "a"), at(10, "b"), at(7, "c")]).map(f => f.id)).toEqual(["b", "c", "a"]);
  });

  it("puts inserts last, whatever the ranking said", () => {
    const bridge = finding({
      id: "bridge",
      changes: [{ op: "prepend-import", path: "/p/CLAUDE.md", assistant: "claude-code", after: "@AGENTS.md" }],
    });
    expect(applyOrder([bridge, at(3, "a")]).map(f => f.id)).toEqual(["a", "bridge"]);
    // A mined workflow splices into a shared file, so it is an insert too.
    expect(applyOrder([finding({ id: "w", suggestion: suggestion() }), at(3, "a")]).map(f => f.id))
      .toEqual(["a", "w"]);
  });

  it("leaves findings that cannot collide in the order the user read them", () => {
    const plain = [finding({ id: "x" }), finding({ id: "y" }), finding({ id: "z" })];
    expect(applyOrder(plain).map(f => f.id)).toEqual(["x", "y", "z"]);
  });
});

describe("autoEligible", () => {
  it("refuses anything needing judgment, carrying a command, or installing an artifact", () => {
    expect(autoEligible(finding({ deterministic: false })).ok).toBe(false);
    expect(autoEligible(finding({ commandBearing: true })).ok).toBe(false);
    expect(autoEligible(finding({ suggestion: suggestion() })).ok).toBe(false);
    expect(autoEligible(finding({ changes: [] })).ok).toBe(false);
  });

  it("accepts an additive change to a gradient-owned or import-only path", () => {
    expect(autoEligible(finding({
      changes: [{ op: "prepend-import", path: "/p/CLAUDE.md", assistant: "claude-code", after: "@AGENTS.md" }],
    })).ok).toBe(true);
  });

  it("refuses a line edit even when every other signal is green", () => {
    expect(autoEligible(finding({
      changes: [{ op: "delete-line", path: "/p/CLAUDE.md", assistant: "claude-code", line: 1 }],
    })).ok).toBe(false);
  });
});

describe("optimizeJson", () => {
  it("carries findings and their eligibility, and no mined transcript text", () => {
    const parsed = JSON.parse(optimizeJson({
      targets: ["claude-code"],
      findings: [finding({
        changes: [{ op: "prepend-import", path: "/p/CLAUDE.md", assistant: "claude-code", after: "@AGENTS.md" }],
      })],
      applied: [], skipped: [], installedSkill: [],
    }));
    expect(parsed.findings[0]).toMatchObject({ id: "f1", family: "stale", autoEligible: true });
    expect(parsed.findings[0].changes[0]).toMatchObject({ op: "prepend-import", after: "@AGENTS.md" });
    expect(JSON.stringify(parsed)).not.toContain("sourceSignatures");
  });
});

describe("the checkup page", () => {
  /**
   * It was written only for `--page`, a flag you had to already know about.
   * The findings are a ranked list of ids and evidence; the page is where that
   * list is actually reviewable, so it is written on every run.
   */
  it("is written without being asked for", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const dir = await tree({ "CLAUDE.md": "- see scripts/gone.sh\n" });
    const result = await optimize(dir, { target: "both", home }, { suggestions: [] });
    expect(result.pagePath).toBeDefined();
    const html = await readFile(result.pagePath!, "utf8");
    expect(html).toContain("<html");
    // A page nobody can act from is just a file: it carries the run's findings.
    expect(html).toContain("gone.sh");
  });

  /**
   * `--apply` opens its own run. Writing the page in a *separate* run gave the
   * reader a run id that `--undo` does not name, and burned two of the ten
   * retained runs per invocation.
   */
  it("shares one run with whatever was applied, so --undo names the page's run", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const dir = await tree({ "CLAUDE.md": "- see scripts/gone.sh\n" });
    const survey = await optimize(dir, { target: "both", home }, { suggestions: [] });
    const id = survey.findings[0]!.id;
    const applied = await optimize(dir, { target: "both", home, apply: [id] }, { suggestions: [] });
    expect(applied.runId).toBeDefined();
    expect(applied.pagePath).toContain(applied.runId!);
  });

  it("names the page in --json, so an agent can point at it", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const dir = await tree({ "CLAUDE.md": "- see scripts/gone.sh\n" });
    const result = await optimize(dir, { target: "both", home }, { suggestions: [] });
    expect(JSON.parse(optimizeJson(result)).pagePath).toBe(result.pagePath);
  });
});

describe("the feature state on the result", () => {
  /**
   * Most people reach `optimize` through the skill, which runs `--json` and
   * never sees the terminal. Putting the switches only in the terminal block
   * would have pointed them out to the smaller half of the audience.
   */
  it("travels with the findings, so --json carries it too", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const dir = await tree({ "CLAUDE.md": "- see scripts/gone.sh\n" });
    const result = await optimize(dir, { target: "both", home }, { suggestions: [] });
    expect(result.features?.map(feature => feature.name)).toEqual([...FEATURES]);
    // A row with no purpose is a switch nobody can evaluate.
    for (const feature of result.features ?? []) {
      expect(feature.purpose, `${feature.name} has no purpose`).not.toBe("");
    }
    expect(JSON.parse(optimizeJson(result)).features).toEqual(result.features);
  });
});
