import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySuggestion } from "./apply.js";
import { addEntry, loadManifest } from "./manifest.js";
import { installHook } from "./settings.js";
import { remove } from "../commands/remove.js";
import type { Suggestion } from "./types.js";
import { approvalMatches, loadArtifactApprovals } from "./approvals.js";

const base = { id: "x", title: "t", rationale: "r", evidence: { count: 3, sessions: 2 }, confidence: "high" as const };

async function testDirs(): Promise<{ dir: string; home: string }> {
  return {
    dir: await mkdtemp(join(tmpdir(), "grad-")),
    home: await mkdtemp(join(tmpdir(), "grad-home-")),
  };
}

describe("applySuggestion", () => {
  it("refuses every unresolved flagged suggestion at the core write boundary", async () => {
    const { dir, home } = await testDirs();
    const suggestion: Suggestion = {
      ...base,
      name: "ambiguous",
      confidence: "flagged",
      payload: { type: "command", commandName: "ambiguous", body: "Do one of two things." },
    };
    await expect(applySuggestion(suggestion, dir, { home })).rejects.toThrow(/unresolved flagged/);
    expect(await loadManifest(dir)).toEqual([]);
  });

  it("writes a SKILL.md by default and records manifest type skill", async () => {
    const { dir, home } = await testDirs();
    const s: Suggestion = {
      ...base,
      name: "lgtm",
      payload: { type: "command", commandName: "lgtm", body: "approve it", triggers: ["lgtm"] },
    };
    const r = await applySuggestion(s, dir, { home });
    expect(r.written).toBe(join(dir, ".claude/skills/lgtm/SKILL.md"));
    expect(await readFile(r.written!, "utf8")).toContain("approve it");
    expect((await loadManifest(dir))[0]).toMatchObject({ name: "lgtm", type: "skill" });
    expect(approvalMatches(await loadArtifactApprovals(dir, home), (await loadManifest(dir))[0], await readFile(r.written!, "utf8"))).toBe(true);
  });

  it("writes a command file and records it in the manifest", async () => {
    const { dir, home } = await testDirs();
    const s: Suggestion = { ...base, name: "ship", payload: { type: "command", commandName: "ship", body: "do it" } };
    const r = await applySuggestion(s, dir, { emitTarget: "command", home });
    expect(r.written).toBe(join(dir, ".claude/commands/ship.md"));
    expect(await readFile(r.written!, "utf8")).toContain("do it");
    expect((await loadManifest(dir))[0]).toMatchObject({ name: "ship", type: "command" });
  });

  it("refuses to overwrite an untracked hand-written skill", async () => {
    const { dir, home } = await testDirs();
    const path = join(dir, ".claude", "skills", "ship", "SKILL.md");
    await mkdir(join(dir, ".claude", "skills", "ship"), { recursive: true });
    await writeFile(path, "hand-written skill\n");
    const s: Suggestion = {
      ...base,
      name: "ship",
      payload: { type: "command", commandName: "ship", body: "generated body" },
    };

    await expect(applySuggestion(s, dir, { home })).rejects.toThrow(/untracked artifact/);
    expect(await readFile(path, "utf8")).toBe("hand-written skill\n");
    expect(await loadManifest(dir)).toEqual([]);
  });

  it("refuses a forged manifest that claims a hand-written skill", async () => {
    const { dir, home } = await testDirs();
    const path = join(dir, ".claude", "skills", "ship", "SKILL.md");
    await mkdir(join(dir, ".claude", "skills", "ship"), { recursive: true });
    await writeFile(path, "hand-written skill\n");
    await addEntry(dir, {
      name: "ship", type: "skill", path,
      createdAt: "2026-07-01", suggestionId: "x",
    });
    const suggestion: Suggestion = {
      ...base, name: "ship",
      payload: { type: "command", commandName: "ship", body: "generated body" },
    };
    await expect(applySuggestion(suggestion, dir, { home })).rejects.toThrow(/provenance/);
    expect(await readFile(path, "utf8")).toBe("hand-written skill\n");
  });

  it("can update a skill already tracked under the same manifest name", async () => {
    const { dir, home } = await testDirs();
    const first: Suggestion = {
      ...base,
      name: "ship",
      payload: { type: "command", commandName: "ship", body: "first body" },
    };
    await applySuggestion(first, dir, { home });
    await applySuggestion({ ...first, payload: { ...first.payload, body: "updated body" } }, dir, { home });
    expect(await readFile(join(dir, ".claude", "skills", "ship", "SKILL.md"), "utf8")).toContain("updated body");
  });

  it("refuses a tracked artifact symlink without touching its victim", async () => {
    const { dir, home } = await testDirs();
    const outside = await mkdtemp(join(tmpdir(), "grad-victim-"));
    const victim = join(outside, "victim.txt");
    const path = join(dir, ".claude", "skills", "ship", "SKILL.md");
    await writeFile(victim, "keep me");
    await mkdir(join(dir, ".claude", "skills", "ship"), { recursive: true });
    await symlink(victim, path);
    await addEntry(dir, { name: "ship", type: "skill", path, createdAt: "2026-07-01", suggestionId: "x" });
    const suggestion: Suggestion = {
      ...base, name: "ship",
      payload: { type: "command", commandName: "ship", body: "replace victim" },
    };
    await expect(applySuggestion(suggestion, dir, { home })).rejects.toThrow(/symlink/);
    expect(await readFile(victim, "utf8")).toBe("keep me");
  });

  it("prints (does not write) a loop suggestion but still records it", async () => {
    const { dir, home } = await testDirs();
    const s: Suggestion = { ...base, name: "cont", payload: { type: "loop", instruction: "continue until done" } };
    const r = await applySuggestion(s, dir, { home });
    expect(r.written).toBeUndefined();
    expect(r.printed).toContain("/loop");
    expect((await loadManifest(dir)).map(e => e.name)).toEqual(["cont"]);
  });

  it("applies a project rule as a manifest-tracked file", async () => {
    const { dir, home } = await testDirs();
    const suggestion: Suggestion = {
      ...base,
      id: "r1",
      name: "prefer-recommended",
      title: "Prefer the recommended option",
      confidence: "inferred",
      evidence: { count: 36, sessions: 27 },
      payload: {
        type: "rule",
        target: "project",
        ruleName: "prefer-recommended",
        text: "Default to the recommended option.",
      },
    };
    const result = await applySuggestion(suggestion, dir, { home });
    expect(result.written).toBe(join(dir, ".claude", "rules", "gradient-prefer-recommended.md"));
    expect((await loadManifest(dir))[0]).toMatchObject({ name: "prefer-recommended", type: "rule" });
  });

  it("refuses a project-rule directory symlink without touching its victim", async () => {
    const { dir, home } = await testDirs();
    const outside = await mkdtemp(join(tmpdir(), "grad-rule-victim-"));
    await mkdir(join(dir, ".claude"), { recursive: true });
    await symlink(outside, join(dir, ".claude", "rules"));
    const suggestion: Suggestion = {
      ...base, name: "prefer-pnpm", title: "Prefer pnpm",
      payload: { type: "rule", target: "project", ruleName: "prefer-pnpm", text: "Prefer pnpm." },
    };
    await expect(applySuggestion(suggestion, dir, { home })).rejects.toThrow(/symlink/);
    await expect(readFile(join(outside, "gradient-prefer-pnpm.md"), "utf8")).rejects.toThrow();
  });

  it("prints a user rule without writing a file", async () => {
    const { dir, home } = await testDirs();
    const suggestion: Suggestion = {
      ...base,
      id: "r2",
      name: "prefer-recommended",
      payload: {
        type: "rule",
        target: "user",
        ruleName: "prefer-recommended",
        text: "Default to the recommended option.",
      },
    };
    const result = await applySuggestion(suggestion, dir, { home });
    expect(result.written).toBeUndefined();
    expect(result.printed).toContain("~/.claude/CLAUDE.md");
    expect((await loadManifest(dir))[0]).toMatchObject({ type: "rule", path: "" });
  });

  it("fans command skills out to Claude Code and Codex", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const suggestion: Suggestion = {
      ...base,
      id: "multi",
      name: "fix-push",
      payload: {
        type: "command",
        commandName: "fix-push",
        body: "Retarget and push.",
        mechanical: true,
      },
    };
    const result = await applySuggestion(suggestion, dir, {
      targets: ["claude-code", "codex"],
      cheapModel: "haiku",
    });
    expect(result.writes.map(write => write.target)).toEqual(["claude-code", "codex"]);
    expect(result.writes[0].path).toBe(join(dir, ".claude", "skills", "fix-push", "SKILL.md"));
    expect(result.writes[1].path).toBe(join(dir, ".agents", "skills", "fix-push", "SKILL.md"));
    expect(await readFile(result.writes[0].path, "utf8")).toContain('model: "haiku"');
    expect(await readFile(result.writes[1].path, "utf8")).not.toContain("model:");
    expect(await loadManifest(dir)).toHaveLength(2);
  });

  it("skips Codex for non-skill payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const suggestion: Suggestion = {
      ...base,
      name: "continue",
      payload: { type: "loop", instruction: "Keep going until done." },
    };
    const result = await applySuggestion(suggestion, dir, { targets: ["claude-code", "codex"] });
    expect(result.skippedTargets).toEqual(["codex"]);
    expect(result.printed).toContain("/loop");
    expect(await loadManifest(dir)).toHaveLength(1);
  });

  it("keeps successful target writes and reports another target's failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await mkdir(join(dir, ".agents", "skills", "ship"), { recursive: true });
    await writeFile(join(dir, ".agents", "skills", "ship", "SKILL.md"), "hand-written\n");
    const suggestion: Suggestion = {
      ...base,
      name: "ship",
      payload: { type: "command", commandName: "ship", body: "Generated." },
    };
    const result = await applySuggestion(suggestion, dir, { targets: ["claude-code", "codex"] });
    expect(result.writes.map(write => write.target)).toEqual(["claude-code"]);
    expect(result.failures[0]).toMatchObject({ target: "codex" });
    expect(await readFile(join(dir, ".agents", "skills", "ship", "SKILL.md"), "utf8")).toBe("hand-written\n");
    expect(await readFile(join(dir, ".claude", "skills", "ship", "SKILL.md"), "utf8")).toContain("Generated.");
  });

  it("refuses a repository-controlled .agents symlink without touching its victim", async () => {
    const { dir, home } = await testDirs();
    const outside = await mkdtemp(join(tmpdir(), "grad-agents-victim-"));
    await symlink(outside, join(dir, ".agents"));
    const suggestion: Suggestion = {
      ...base,
      name: "ship",
      payload: { type: "command", commandName: "ship", body: "Generated." },
    };
    await expect(applySuggestion(suggestion, dir, { targets: ["codex"], home })).rejects.toThrow(/symlink/);
    await expect(readFile(join(outside, "skills", "ship", "SKILL.md"), "utf8")).rejects.toThrow();
  });

  it("writes a Claude project rule but keeps the Codex AGENTS.md step print-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const suggestion: Suggestion = {
      ...base,
      name: "prefer-pnpm",
      payload: {
        type: "rule",
        target: "project",
        ruleName: "prefer-pnpm",
        text: "Use pnpm without asking.",
      },
    };
    const result = await applySuggestion(suggestion, dir, { targets: ["claude-code", "codex"] });
    expect(result.writes).toHaveLength(1);
    expect(result.printed).toContain("repository AGENTS.md");
    expect(result.printed).toContain("Use pnpm without asking.");
    expect(await loadManifest(dir)).toHaveLength(2);
  });

  it("approving a hook installs it into project settings instead of printing JSON", async () => {
    const { dir, home } = await testDirs();
    const suggestion: Suggestion = {
      ...base,
      name: "notify-when-waiting",
      payload: {
        type: "hook",
        event: "Notification",
        matcher: "permission_prompt|idle_prompt",
        subcommand: "notify",
        description: "Desktop notification when Claude needs input",
      },
    };
    const result = await applySuggestion(suggestion, dir, { home });
    expect(result.printed).toBeUndefined();
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0].path).toBe(join(dir, ".claude", "settings.local.json"));
    const settings = JSON.parse(await readFile(result.writes[0].path, "utf8"));
    expect(settings.hooks.Notification[0]).toMatchObject({
      matcher: "permission_prompt|idle_prompt",
      hooks: [{ type: "command", command: "gradient notify" }],
    });
    expect((await loadManifest(dir))[0]).toMatchObject({
      name: "notify-when-waiting",
      type: "hook",
      path: "",
      hook: { event: "Notification", command: "gradient notify" },
    });
  });

  it("removing a hook artifact un-merges it and preserves unrelated hooks", async () => {
    const { dir, home } = await testDirs();
    const suggestion: Suggestion = {
      ...base,
      name: "notify-when-waiting",
      payload: {
        type: "hook",
        event: "Notification",
        matcher: "permission_prompt|idle_prompt",
        subcommand: "notify",
        description: "Desktop notification when Claude needs input",
      },
    };
    await applySuggestion(suggestion, dir, { home });
    await installHook(dir, "Notification", "afplay /System/Library/Sounds/Ping.aiff");
    expect(await remove(dir, "notify-when-waiting", { home })).toBe(true);
    const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.local.json"), "utf8"));
    const commands = (settings.hooks?.Notification ?? []).flatMap(
      (group: { hooks: { command: string }[] }) => group.hooks.map(hook => hook.command),
    );
    expect(commands).toEqual(["afplay /System/Library/Sounds/Ping.aiff"]);
    expect(await loadManifest(dir)).toEqual([]);
  });

  it("installs and exactly removes a reviewed command hook", async () => {
    const { dir, home } = await testDirs();
    const suggestion: Suggestion = {
      ...base,
      id: "raw-hook-1",
      name: "post-edit-lint",
      confidence: "inferred",
      payload: {
        type: "hook",
        event: "PostToolUse",
        matcher: "Edit|Write|NotebookEdit",
        command: "npm run lint",
        description: "lint after edits",
      },
    };
    const applied = await applySuggestion(suggestion, dir, { home });
    expect(applied.written).toBe(join(dir, ".claude", "settings.local.json"));
    const settings = JSON.parse(await readFile(applied.written!, "utf8"));
    expect(settings.hooks.PostToolUse[0]).toEqual({
      matcher: "Edit|Write|NotebookEdit",
      hooks: [{ type: "command", command: "npm run lint" }],
    });
    expect((await loadManifest(dir))[0]).toMatchObject({
      name: "post-edit-lint",
      path: "",
      hook: {
        event: "PostToolUse",
        matcher: "Edit|Write|NotebookEdit",
        command: "npm run lint",
      },
    });

    expect(await remove(dir, "post-edit-lint", { home })).toBe(true);
    const after = JSON.parse(await readFile(applied.written!, "utf8"));
    expect(after.hooks).toBeUndefined();
  });

  it("does not let a forged raw-hook manifest remove an existing user hook", async () => {
    const { dir, home } = await testDirs();
    await installHook(dir, "PostToolUse", "npm run lint", { matcher: "Edit" });
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify([{
      name: "forged-lint",
      type: "hook",
      path: "",
      createdAt: "2026-07-18",
      suggestionId: "forged",
      hook: { event: "PostToolUse", matcher: "Edit", command: "npm run lint" },
    }]));

    await expect(remove(dir, "forged-lint", { home })).rejects.toThrow(/approval/);
    const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.local.json"), "utf8"));
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("npm run lint");
  });
});
