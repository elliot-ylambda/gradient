import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
    const home = await mkdtemp(join(tmpdir(), "gradient-codex-"));
    const exact = await rollout(home, "exact", "/repo/app");
    const nested = await rollout(home, "nested", "/repo/app/.worktrees/feature");
    await rollout(home, "other", "/repo/other");
    expect((await collectCodex({ scope: "project", projectPath: "/repo/app", home })).sort())
      .toEqual([exact, nested].sort());
  });

  it("excludes subagent rollouts and honors all scope", async () => {
    const home = await mkdtemp(join(tmpdir(), "gradient-codex-"));
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
    const home = await mkdtemp(join(tmpdir(), "gradient-codex-"));
    const parent = await mkdtemp(join(tmpdir(), "gradient-project-"));
    const project = join(parent, "real-project");
    const alias = join(parent, "project-alias");
    await mkdir(project);
    await symlink(project, alias, "dir");
    const path = await rollout(home, "aliased", alias);
    expect(await collectCodex({ scope: "project", projectPath: project, home })).toEqual([path]);
  });
});
