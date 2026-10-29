import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadLastCheckup, optimize, optimizeJson, undo } from "./optimize.js";
import { applySuggestion } from "../core/apply.js";
import { insights } from "./insights.js";
import { setContinuity } from "./continuity.js";
import type { Suggestion } from "../core/types.js";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "gradient-optimize-home-"));
  const project = await mkdtemp(join(tmpdir(), "gradient-optimize-project-"));
  return { home, project };
}
async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
const proposal = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: "review-source", name: "review-source", title: "Review changed source",
  rationale: "Repeated task", evidence: { count: 6, sessions: 4 }, confidence: "high",
  payload: { type: "command", commandName: "review-source", body: "Read changed files and report concrete correctness findings." },
  ...over,
});

describe("trustworthy checkup", () => {
  it("uses recorded invocations and never deletes an active generated skill", async () => {
    const { home, project } = await fixture();
    await applySuggestion(proposal(), project, { home, targets: ["claude-code"] });
    const manifestPath = join(project, ".gradient/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest[0].createdAt = "2026-01-01";
    await put(manifestPath, JSON.stringify(manifest));
    const transcript = join(home, ".claude/projects", project.replace(/[^A-Za-z0-9]/g, "-"), "today.jsonl");
    await put(transcript, JSON.stringify({ type: "user", sessionId: "today", cwd: project, timestamp: new Date().toISOString(),
      message: { role: "user", content: "<command-name>/review-source</command-name>" } }) + "\n");
    const result = await optimize(project, { home, target: "claude-code" });
    expect((await insights({ projectDir: project, home })).adoption[0].uses).toBe(1);
    expect(result.findings.some(finding => finding.title.includes("No explicit invocation"))).toBe(false);
    expect(result.applied).toEqual([]);
    expect(await readFile(join(project, ".claude/skills/review-source/SKILL.md"), "utf8")).toContain("Read changed files");
  });

  it("dismisses structural findings and resurfaces changed evidence", async () => {
    const { home, project } = await fixture();
    await put(join(project, "AGENTS.md"), "Use TypeScript for new source files.\n");
    await put(join(project, "CLAUDE.md"), "- Build using scripts/removed.sh before submitting.\n");
    const deps = { suggestions: [] };
    const before = await optimize(project, { home, target: "both" }, deps);
    const ids = before.findings.filter(finding => finding.family === "stale" || finding.family === "drift").map(finding => finding.id);
    expect(ids).toHaveLength(2);
    const denied = await optimize(project, { home, deny: ids }, deps);
    expect(denied.findings.some(finding => ids.includes(finding.id))).toBe(false);
    expect((await optimize(project, { home }, deps)).findings.some(finding => ids.includes(finding.id))).toBe(false);
    expect((await loadLastCheckup(project, { home }))?.findings.some(finding => ids.includes(finding.id))).toBe(false);
    // Which assistants a run inspects is not a change to the evidence.
    expect((await optimize(project, { home, target: "claude-code" }, deps)).findings.some(finding => ids.includes(finding.id))).toBe(false);
    await put(join(project, "CLAUDE.md"), "- Check scripts/removed.sh after every release.\n");
    expect((await optimize(project, { home }, deps)).findings.some(finding => finding.family === "stale")).toBe(true);
  });

  /** Mining runs again every day: the count grows and the example quoted in the
   *  body changes. Neither is the user changing their mind. */
  it("keeps a denied workflow dismissed as its counts and example drift", async () => {
    const { home, project } = await fixture();
    const first = proposal({ sourceSignatures: ["review source"] });
    const initial = await optimize(project, { home, target: "claude-code" }, { suggestions: [first] });
    expect(initial.findings.some(finding => finding.suggestion?.id === first.id)).toBe(true);
    await optimize(project, { home, deny: [first.id] }, { suggestions: [first] });
    const drifted = proposal({
      sourceSignatures: ["review source"], evidence: { count: 9, sessions: 6 },
      payload: { type: "command", commandName: "review-source", body: "Review the diff and list correctness findings." },
    });
    const later = await optimize(project, { home }, { suggestions: [drifted] });
    expect(later.findings.some(finding => finding.suggestion?.id === first.id)).toBe(false);
  });

  it("rejects informational apply and omits its Choose fix button", async () => {
    const { home, project } = await fixture();
    await put(join(home, ".codex/skills/broken/SKILL.md"), "---\nname: broken\n---\nReview a specific task.\n");
    const initial = await optimize(project, { home, target: "codex" }, { suggestions: [] });
    const informational = initial.findings.find(finding => finding.family === "skill-health")!;
    expect(informational).toBeDefined();
    const json = JSON.parse(optimizeJson(initial));
    expect(json.findings.find((finding: { id: string }) => finding.id === informational.id).actionable).toBe(false);
    const html = await readFile(initial.pagePath!, "utf8");
    const card = html.split(`data-id="${informational.id}"`)[1].split("</article>")[0];
    expect(card).not.toContain('data-act="accept"');
    expect(card).toContain('data-act="deny"');
    const result = await optimize(project, { home, apply: [informational.id] }, { suggestions: [] });
    expect(result.applied).toEqual([]);
    expect(result.skipped[0].reason).toContain("needs review");
    expect(result.runId).toBeUndefined();
  });

  it("repairs a bridge even when the import is mentioned literally", async () => {
    const { home, project } = await fixture();
    await put(join(project, "AGENTS.md"), "Use TypeScript for new source files.\n");
    await put(join(project, "CLAUDE.md"), "The bridge convention is `@AGENTS.md`.\n");
    const initial = await optimize(project, { home, target: "both" }, { suggestions: [] });
    const bridge = initial.findings.find(finding => finding.family === "drift")!;
    const result = await optimize(project, { home, apply: [bridge.id] }, { suggestions: [] });
    expect(result.applied).toHaveLength(1);
    expect((await readFile(join(project, "CLAUDE.md"), "utf8")).startsWith("@AGENTS.md\n")).toBe(true);
    expect((await loadLastCheckup(project, { home }))?.findings.some(finding => finding.id === bridge.id)).toBe(false);
    expect((await undo(result.runId!, { home })).restored).toContain(join(project, "CLAUDE.md"));
  });

  it("does not call instructions for separate assistants duplicate context cost", async () => {
    const { home, project } = await fixture();
    await put(join(home, ".claude/CLAUDE.md"), "Use conventional commit messages for all commits.\n");
    await put(join(home, ".codex/AGENTS.md"), "Use conventional commit messages for all commits.\n");
    const result = await optimize(project, { home, target: "both" }, { suggestions: [] });
    expect(result.findings.some(finding => finding.title.includes("multiple inspected files"))).toBe(false);
  });

  it("does not suggest a checkpoint hook when continuity already provides one", async () => {
    const { home, project } = await fixture();
    await setContinuity(true, project, { home });
    const hook = proposal({ payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "Save checkpoint" } });
    const result = await optimize(project, { home, target: "claude-code" }, { suggestions: [hook] });
    expect(result.findings.some(finding => finding.suggestion?.id === hook.id)).toBe(false);
  });

  it("retains the workflow's exact proposed content in JSON for informed review", async () => {
    const { home, project } = await fixture();
    const result = await optimize(project, { home, target: "both" }, { suggestions: [proposal()] });
    const finding = JSON.parse(optimizeJson(result)).findings.find((finding: { family: string }) => finding.family === "workflow");
    expect(finding.preview).toBe("Read changed files and report concrete correctness findings.");
    expect(finding.actionable).toBe(true);
  });
});

it("refuses an old id when the same missing reference now appears in different instructions", async () => {
  const { home, project } = await fixture();
  await put(join(project, "CLAUDE.md"), "- Run scripts/retired.sh before testing.\n");
  const before = await optimize(project, { home, target: "claude-code" }, { suggestions: [] });
  const stale = before.findings.find(finding => finding.family === "stale")!;
  const edited = "- Do not recreate scripts/retired.sh; it was intentionally removed.\n";
  await put(join(project, "CLAUDE.md"), edited);
  const result = await optimize(project, { home, apply: [stale.id] }, { suggestions: [] });
  expect(result.applied).toEqual([]);
  expect(result.skipped[0].reason).toContain("changed since the last checkup");
  expect(await readFile(join(project, "CLAUDE.md"), "utf8")).toBe(edited);
});

it("uses the requested assistant and recency window for its observed metrics", async () => {
  const { home, project } = await fixture();
  const transcript = join(home, ".claude/projects", project.replace(/[^A-Za-z0-9]/g, "-"), "history.jsonl");
  const now = Date.parse("2026-10-28T12:00:00Z");
  await put(transcript, ["2026-10-01T12:00:00Z", "2026-10-28T11:00:00Z"].map((timestamp, index) => JSON.stringify({
    type: "user", sessionId: "history", cwd: project, timestamp,
    message: { role: "user", content: `Inspect source ${index} carefully for correctness issues.` },
  })).join("\n") + "\n");
  const claude = await optimize(project, { home, target: "claude-code", since: 1, now }, { suggestions: [] });
  expect(claude.coverage).toMatchObject({ prompts: 1, label: "project scope · last 1d" });
  const codex = await optimize(project, { home, target: "codex", now }, { suggestions: [] });
  expect(codex.coverage?.prompts).toBe(0);
});

it("keeps imported configured assistant memory read-only", async () => {
  const { home, project } = await fixture();
  // Configured inside the repository, so the import is in-bounds and only the
  // memory guard stands between the finding and an edit.
  const memory = join(project, "assistant-memory", "index.md");
  await put(join(home, ".claude/settings.json"), JSON.stringify({ autoMemoryDirectory: dirname(memory) }));
  await put(memory, "- Build with scripts/removed.sh before submitting.\n");
  await put(join(project, "CLAUDE.md"), "@assistant-memory/index.md\n");
  const result = await optimize(project, { home, target: "claude-code" }, { suggestions: [] });
  const observation = result.findings.find(finding => finding.family === "stale" && finding.changes.length === 0);
  expect(observation).toBeDefined();
  expect(observation?.detail).toContain("assistant-managed memory");
  const applied = await optimize(project, { home, apply: [observation!.id] }, { suggestions: [] });
  expect(applied.applied).toEqual([]);
  expect(await readFile(memory, "utf8")).toBe("- Build with scripts/removed.sh before submitting.\n");
});
