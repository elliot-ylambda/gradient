import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCodex, readCodexSessionMeta } from "./collect-codex.js";

async function rollout(
  home: string,
  name: string,
  cwd: string,
  source: unknown = "cli",
): Promise<string> {
  const dir = join(home, ".codex", "sessions", "2026", "07", "09");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  await writeFile(path, `${JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-09T00:00:00Z",
    payload: { id: name, cwd, source, git: { branch: "main", repository_url: "git@example/repo" } },
  })}\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "ship it" } })}\n`);
  return path;
}

describe("collectCodex", () => {
  it("collects project rollouts and nested worktree sessions", async () => {
    // realpath: collected paths are canonical, and macOS tmpdirs live behind /var → /private/var
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-codex-")));
    const exact = await rollout(home, "exact", "/repo/app");
    const nested = await rollout(home, "nested", "/repo/app/.worktrees/feature");
    await rollout(home, "other", "/repo/other");
    expect((await collectCodex({ scope: "project", projectPath: "/repo/app", home })).sort())
      .toEqual([exact, nested].sort());
  });

  it("excludes subagent rollouts and honors all scope", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-codex-")));
    const root = await rollout(home, "root", "/repo/app");
    await rollout(home, "child", "/repo/app", { subagent: { thread_spawn: {} } });
    await rollout(home, "legacy-child", "/repo/app", "subagent");
    expect(await collectCodex({ scope: "all", home })).toEqual([root]);
  });

  it("reads first-record metadata without reading the conversation shape", async () => {
    const home = await mkdtemp(join(tmpdir(), "gradient-codex-"));
    const path = await rollout(home, "abc", "/repo/app");
    expect(await readCodexSessionMeta(path)).toMatchObject({
      cwd: "/repo/app",
      sessionId: "abc",
      branch: "main",
      repositoryUrl: "git@example/repo",
      subagent: false,
    });
  });

  it("matches project paths through filesystem aliases", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "gradient-codex-")));
    const parent = await mkdtemp(join(tmpdir(), "gradient-project-"));
    const project = join(parent, "real-project");
    const alias = join(parent, "project-alias");
    await mkdir(project);
    await symlink(project, alias, "dir");
    const path = await rollout(home, "aliased", alias);
    expect(await collectCodex({ scope: "project", projectPath: project, home })).toEqual([path]);
  });

  it("follows a user-managed symlinked sessions root", async () => {
    const home = await mkdtemp(join(tmpdir(), "gradient-codex-"));
    const outside = await mkdtemp(join(tmpdir(), "gradient-dotfiles-"));
    await mkdir(join(home, ".codex"), { recursive: true });
    await symlink(outside, join(home, ".codex", "sessions"));
    await rollout(home, "linked-root", "/repo/app"); // written through the symlink
    const warnings: string[] = [];
    const files = await collectCodex({ scope: "all", home, onWarn: m => warnings.push(m) });
    expect(files).toHaveLength(1);
    expect(files[0].endsWith("linked-root.jsonl")).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("warns and refuses a symlink beneath the sessions root", async () => {
    const home = await mkdtemp(join(tmpdir(), "gradient-codex-"));
    const outside = await mkdtemp(join(tmpdir(), "gradient-victim-"));
    const root = join(home, ".codex", "sessions");
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "2026"));
    const warnings: string[] = [];
    expect(await collectCodex({ scope: "all", home, onWarn: m => warnings.push(m) })).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(root, "2026"));
    expect(warnings[0]).toContain("symlink");
  });
});
