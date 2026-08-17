import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { MAX_TRANSCRIPT_BYTES } from "./parse.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir, matchesSince, collect } from "./collect.js";

describe("collect helpers", () => {
  it("encodes a cwd to a projects dir name", () => {
    expect(encodeProjectDir("/Users/x/projects/y")).toBe("-Users-x-projects-y");
    expect(encodeProjectDir("C:\\Users\\x\\project")).toBe("C--Users-x-project");
  });

  /**
   * Claude Code dashes out every character outside [A-Za-z0-9], so a dot
   * directory shows up as a double dash. Replacing only the separators left a
   * literal `.` in the name, which matched no directory at all — and since a
   * missing history directory reads exactly like an empty one, the report just
   * said zero. Every one of these is a real directory name observed on disk.
   */
  it("dashes out dots, so a project under a dot directory is not invisible", () => {
    expect(encodeProjectDir("/Users/u/.clinch/worktrees/gradient/dawn-ember"))
      .toBe("-Users-u--clinch-worktrees-gradient-dawn-ember");
    expect(encodeProjectDir("/Users/u/projects/gradient/.claude/worktrees/spec"))
      .toBe("-Users-u-projects-gradient--claude-worktrees-spec");
    expect(encodeProjectDir("/Users/u/sites/site.com")).toBe("-Users-u-sites-site-com");
  });

  // Underscore and plus are likewise dashed; branch names carry both.
  it("dashes out every other non-alphanumeric too", () => {
    expect(encodeProjectDir("/tmp/T/tmp-hsvzik_p/run")).toBe("-tmp-T-tmp-hsvzik-p-run");
    expect(encodeProjectDir("/w/.claude/worktrees/elliot+restyle"))
      .toBe("-w--claude-worktrees-elliot-restyle");
  });
  it("matchesSince keeps recent files and drops old ones", () => {
    const now = 1_000_000_000_000;
    const day = 86_400_000;
    expect(matchesSince(now - 2 * day, 7, now)).toBe(true);
    expect(matchesSince(now - 10 * day, 7, now)).toBe(false);
    expect(matchesSince(now - 999 * day, undefined, now)).toBe(true); // no filter
  });
});

describe("collect", () => {
  it("project scope sweeps the project's claude-worktrees sibling dirs", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const root = join(home, ".claude", "projects");
    const enc = encodeProjectDir("/p/x");
    await mkdir(join(root, enc), { recursive: true });
    await mkdir(join(root, `${enc}--claude-worktrees-feat`), { recursive: true });
    await mkdir(join(root, `${enc}-other`), { recursive: true }); // different project sharing the prefix
    await writeFile(join(root, enc, "a.jsonl"), "{}");
    await writeFile(join(root, `${enc}--claude-worktrees-feat`, "wt.jsonl"), "{}");
    await writeFile(join(root, `${enc}-other`, "n.jsonl"), "{}");
    const files = await collect({ scope: "project", projectPath: "/p/x", home });
    expect(files.map(f => f.split("/").pop()).sort()).toEqual(["a.jsonl", "wt.jsonl"]);
  });

  // The end-to-end shape of the encoding bug: gradient run from inside a
  // worktree manager's dot directory found none of its own history.
  it("project scope finds a project living under a dot directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const cwd = "/Users/u/.clinch/worktrees/gradient/dawn-ember";
    const proj = join(home, ".claude", "projects", "-Users-u--clinch-worktrees-gradient-dawn-ember");
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, "a.jsonl"), "{}");
    expect(await collect({ scope: "project", projectPath: cwd, home })).toHaveLength(1);
  });

  // `.claude/worktrees/` and a plain `.worktrees/` are both in use; only the
  // first was swept, so a whole checkout convention read as no history.
  it("project scope sweeps a plain .worktrees sibling as well", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const root = join(home, ".claude", "projects");
    const enc = encodeProjectDir("/p/x");
    await mkdir(join(root, `${enc}--worktrees-feat`), { recursive: true });
    await mkdir(join(root, `${enc}--claude-worktrees-feat`), { recursive: true });
    await writeFile(join(root, `${enc}--worktrees-feat`, "plain.jsonl"), "{}");
    await writeFile(join(root, `${enc}--claude-worktrees-feat`, "dot.jsonl"), "{}");
    const files = await collect({ scope: "project", projectPath: "/p/x", home });
    expect(files.map(f => f.split("/").pop()).sort()).toEqual(["dot.jsonl", "plain.jsonl"]);
  });

  /**
   * The longest session is the one with the most signal, and a per-file byte
   * cap dropped exactly that one — silently, and for no gain: the reader
   * already takes only the newest MAX_TRANSCRIPT_BYTES of any transcript.
   */
  it("keeps a transcript larger than one bounded read", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const proj = join(home, ".claude", "projects", encodeProjectDir("/p/x"));
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, "long.jsonl"), Buffer.alloc(MAX_TRANSCRIPT_BYTES + 1_000_000));
    expect(await collect({ scope: "project", projectPath: "/p/x", home })).toHaveLength(1);
  });

  it("finds project jsonl files and skips subagents", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-"));
    const proj = join(home, ".claude", "projects", encodeProjectDir("/p/x"));
    await mkdir(join(proj, "subagents"), { recursive: true });
    await writeFile(join(proj, "a.jsonl"), "{}");
    await writeFile(join(proj, "subagents", "b.jsonl"), "{}");
    const files = await collect({ scope: "project", projectPath: "/p/x", home });
    expect(files.length).toBe(1);
    expect(files[0].endsWith("a.jsonl")).toBe(true);
  });

  // The transcript root itself is the user's own config: a dotfiles-managed
  // ~/.claude (or a projects dir moved to another disk) must work out of the
  // box. Only symlinks discovered BENEATH the resolved root are refused.
  it("follows a user-managed symlinked transcript root", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const outside = await mkdtemp(join(tmpdir(), "grad-dotfiles-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(outside, "real.jsonl"), '{"type":"user"}');
    await symlink(outside, join(home, ".claude", "projects"));
    const warnings: string[] = [];
    const files = await collect({ scope: "all", home, onWarn: m => warnings.push(m) });
    expect(files).toHaveLength(1);
    expect(files[0].endsWith("real.jsonl")).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("warns and refuses a symlink beneath the transcript root", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const outside = await mkdtemp(join(tmpdir(), "grad-victim-"));
    const root = join(home, ".claude", "projects");
    await mkdir(root, { recursive: true });
    await writeFile(join(outside, "stolen.jsonl"), '{"type":"user"}');
    await symlink(outside, join(root, "linked-project"));
    const warnings: string[] = [];
    expect(await collect({ scope: "all", home, onWarn: m => warnings.push(m) })).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(root, "linked-project"));
    expect(warnings[0]).toContain("symlink");
  });

  it("project scope warns once when the project's own transcript dir is a symlink", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const outside = await mkdtemp(join(tmpdir(), "grad-victim-"));
    const root = join(home, ".claude", "projects");
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, encodeProjectDir("/p/x")));
    const warnings: string[] = [];
    await collect({ scope: "project", projectPath: "/p/x", home, onWarn: m => warnings.push(m) });
    expect(warnings).toHaveLength(1);
  });
});
