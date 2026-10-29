import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applySuggestion, applySuggestionTransactional, reverseBookkeeping } from "./apply.js";
import { beginRun, saveResult, undoRun } from "./run.js";
import { approvalLedgerPath } from "./approvals.js";
import { configPath, loadConfig, saveConfig } from "../config.js";
import { settingsPath } from "./settings.js";
import { playbookPinPath } from "./playbook.js";
import type { Assistant, Suggestion } from "./types.js";

const proposal = (over: Partial<Suggestion> = {}): Suggestion => ({
  id: "review-source", name: "review-source", title: "Review changed source",
  rationale: "Repeated task", evidence: { count: 6, sessions: 4 }, confidence: "high",
  payload: { type: "command", commandName: "review-source", body: "Read changed files and report concrete correctness findings." },
  ...over,
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "gradient-transaction-home-"));
  const project = await mkdtemp(join(tmpdir(), "gradient-transaction-project-"));
  return { home, project };
}
async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}
async function apply(item: Suggestion, project: string, home: string, targets: Assistant[] = ["claude-code", "codex"]) {
  const run = await beginRun({ home });
  const outcome = await applySuggestionTransactional(item, project, run, { home, targets });
  await saveResult(run, { runId: run.id, startedAt: run.startedAt, wrote: outcome.wrote,
    applied: [{ id: item.id, title: item.title, paths: outcome.paths }], skipped: [], bookkeeping: outcome.bookkeeping });
  return { run, outcome };
}
const undo = (runId: string, home: string) =>
  undoRun(runId, { home, reverseBookkeeping: records => reverseBookkeeping(records, home) });

describe("workflow transactions", () => {
  it("undoes both assistant skills and removes only this run's manifest entries", async () => {
    const { home, project } = await fixture();
    await applySuggestion(proposal({ id: "prior", name: "prior", payload: { type: "command", commandName: "prior", body: "Preserve this skill." } }), project, { home });
    const manifest = join(project, ".gradient", "manifest.json");
    const ledger = approvalLedgerPath(project, home);
    const originalManifest = await readFile(manifest, "utf8");
    const { run, outcome } = await apply(proposal(), project, home);
    // Shared bookkeeping is reversed by entry, so it is never an undo conflict.
    expect(outcome.paths).not.toContain(manifest);
    expect(outcome.paths).not.toContain(ledger);
    const result = await undo(run.id, home);
    expect(result.conflicted).toEqual([]);
    for (const root of [".claude", ".agents"]) {
      await expect(readFile(join(project, root, "skills/review-source/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(manifest, "utf8")).toBe(originalManifest);
    // A content-keyed approval of bytes that are gone is inert; the prior one stays.
    expect(await readFile(ledger, "utf8")).toContain("\"name\": \"prior\"");
    expect(await readFile(join(project, ".claude/skills/prior/SKILL.md"), "utf8")).toContain("Preserve this skill");
  });

  it("undoes an earlier run after a later apply and a settings change", async () => {
    const { home, project } = await fixture();
    const first = await apply(proposal(), project, home);
    await apply(proposal({ id: "second", name: "second", payload: { type: "command", commandName: "second", body: "Keep this one." } }), project, home);
    await saveConfig({ ...(await loadConfig(home)), autopilotProjects: { [project]: "nudge" } }, home);
    const result = await undo(first.run.id, home);
    expect(result.conflicted).toEqual([]);
    await expect(readFile(join(project, ".claude/skills/review-source/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(project, ".claude/skills/second/SKILL.md"), "utf8")).toContain("Keep this one");
    const names = JSON.parse(await readFile(join(project, ".gradient/manifest.json"), "utf8")).map((entry: { name: string }) => entry.name);
    expect([...new Set(names)]).toEqual(["second"]);
    expect((await loadConfig(home)).autopilotProjects).toEqual({ [project]: "nudge" });
  });

  it("undoes shared AGENTS rules without losing the user's instructions", async () => {
    const { home, project } = await fixture();
    const agents = join(project, "AGENTS.md");
    await put(agents, "# Project\n\nPreserve this instruction.\n");
    const { run } = await apply(proposal({ payload: { type: "rule", target: "project", ruleName: "review-source", text: "Prefer named exports." } }), project, home);
    expect(await readFile(agents, "utf8")).toContain("Prefer named exports");
    expect((await undo(run.id, home)).conflicted).toEqual([]);
    expect(await readFile(agents, "utf8")).toBe("# Project\n\nPreserve this instruction.\n");
    await expect(readFile(join(project, ".claude/rules/gradient-review-source.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("undoes hook settings, private consent, manifest, and approvals together", async () => {
    const { home, project } = await fixture();
    await saveConfig({ targets: ["claude-code"], continuityProjects: ["/another/project"] }, home);
    await put(settingsPath(project), JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { PreCompact: [{ hooks: [{ type: "command", command: "echo personal" }] }] } }));
    const settingsBefore = await readFile(settingsPath(project), "utf8");
    const configBefore = await readFile(configPath(home), "utf8");
    const { run } = await apply(proposal({ payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "Save checkpoint" } }), project, home, ["claude-code"]);
    expect(await readFile(configPath(home), "utf8")).toContain(project);
    expect((await undo(run.id, home)).conflicted).toEqual([]);
    expect(await readFile(settingsPath(project), "utf8")).toBe(settingsBefore);
    expect(await readFile(configPath(home), "utf8")).toBe(configBefore);
    expect(JSON.parse(await readFile(join(project, ".gradient/manifest.json"), "utf8"))).toEqual([]);
  });

  it("undoes a project playbook entry and its private consent pin", async () => {
    const { home, project } = await fixture();
    const playbook = join(project, "gradient.md");
    await put(playbook, "# Team notes\n\n## Rules\n\n- Preserve this rule.\n");
    const { run } = await apply(proposal({ payload: { type: "project-playbook", section: "rules", text: "Prefer concise summaries." } }), project, home, ["claude-code"]);
    expect(await readFile(playbookPinPath(project, home), "utf8")).toContain("Prefer concise summaries");
    expect((await undo(run.id, home)).conflicted).toEqual([]);
    expect(await readFile(playbook, "utf8")).toBe("# Team notes\n\n## Rules\n\n- Preserve this rule.\n");
    await expect(readFile(playbookPinPath(project, home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back the first target and all bookkeeping when the second target fails", async () => {
    const { home, project } = await fixture();
    const codex = join(project, ".agents/skills/review-source/SKILL.md");
    await put(codex, "Handwritten skill; do not overwrite.\n");
    await expect(apply(proposal(), project, home)).rejects.toThrow(/untracked artifact/);
    expect(await readFile(codex, "utf8")).toBe("Handwritten skill; do not overwrite.\n");
    await expect(readFile(join(project, ".claude/skills/review-source/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(project, ".gradient/manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(approvalLedgerPath(project, home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preflights the whole undo so edited artifacts keep their corresponding metadata", async () => {
    const { home, project } = await fixture();
    const { run } = await apply(proposal(), project, home);
    const changed = join(project, ".agents/skills/review-source/SKILL.md");
    const manifest = await readFile(join(project, ".gradient/manifest.json"), "utf8");
    const ledger = await readFile(approvalLedgerPath(project, home), "utf8");
    await put(changed, "User edited the installed skill.\n");
    expect(await undo(run.id, home)).toEqual({ restored: [], conflicted: [changed] });
    expect(await readFile(changed, "utf8")).toBe("User edited the installed skill.\n");
    expect(await readFile(join(project, ".gradient/manifest.json"), "utf8")).toBe(manifest);
    expect(await readFile(approvalLedgerPath(project, home), "utf8")).toBe(ledger);
    expect(await readFile(join(project, ".claude/skills/review-source/SKILL.md"), "utf8")).toContain("Review changed source");
  });

  it("preserves later settings edits instead of partly uninstalling the hook", async () => {
    const { home, project } = await fixture();
    const { run } = await apply(proposal({ payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "Save checkpoint" } }), project, home, ["claude-code"]);
    const settings = JSON.parse(await readFile(settingsPath(project), "utf8"));
    settings.permissions = { deny: ["Bash"] };
    const edited = JSON.stringify(settings);
    await put(settingsPath(project), edited);
    const outcome = await undo(run.id, home);
    expect(outcome.restored).toEqual([]);
    expect(outcome.conflicted).toContain(settingsPath(project));
    expect(await readFile(settingsPath(project), "utf8")).toBe(edited);
    expect(await readFile(configPath(home), "utf8")).toContain(project);
  });
});
