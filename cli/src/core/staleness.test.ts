import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRefs, findStaleRefs, readRepoFacts } from "./staleness.js";
import { extractLines, type InstructionSource } from "./instructions.js";

const source: InstructionSource = {
  path: "/p/CLAUDE.md", scope: "project", assistant: "claude-code",
  kind: "claude-md", lineCount: 1, bytes: 1,
};
const userSource: InstructionSource = { ...source, scope: "user" };

const linesOf = (text: string, from: InstructionSource = source) => extractLines(text, from);

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-stale-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

describe("extractRefs", () => {
  it("reads backticked literals and bare path-shaped tokens", () => {
    expect(extractRefs("Run `npm run build` before touching src/api/handler.ts here"))
      .toEqual(["npm run build", "src/api/handler.ts"]);
  });

  it("ignores globs, placeholders, urls, and prose", () => {
    expect(extractRefs("Files under `src/**/*.ts` and <your-path>/thing and https://example.com/a/b"))
      .toEqual([]);
    expect(extractRefs("Always be careful when editing things")).toEqual([]);
  });

  it("strips trailing sentence punctuation from a reference", () => {
    expect(extractRefs("The entry point is src/index.ts.")).toEqual(["src/index.ts"]);
  });
});

describe("readRepoFacts", () => {
  it("reads npm scripts and Makefile targets", async () => {
    const dir = await repo({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest" } }),
      "Makefile": ".PHONY: publish\npublish:\n\techo hi\nrelease-check:\n\techo ok\nVAR := 1\n",
    });
    const facts = await readRepoFacts(dir);
    expect([...facts.scripts].sort()).toEqual(["build", "test"]);
    expect([...facts.makeTargets].sort()).toEqual(["publish", "release-check"]);
  });

  it("survives a missing or malformed package.json", async () => {
    expect((await readRepoFacts(await repo({}))).scripts.size).toBe(0);
    expect((await readRepoFacts(await repo({ "package.json": "{not json" }))).scripts.size).toBe(0);
  });
});

describe("findStaleRefs", () => {
  it("flags a path the code deleted and leaves a live one alone", async () => {
    const dir = await repo({ "src/index.ts": "export {};\n" });
    const lines = linesOf([
      "- The entry point is `src/index.ts` for this project",
      "- Build with `scripts/build.sh` before you commit",
    ].join("\n"));
    const stale = await findStaleRefs(lines, dir);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ ref: "scripts/build.sh", kind: "path" });
    expect(stale[0].line.line).toBe(2);
  });

  it("flags a script the package.json no longer has", async () => {
    const dir = await repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    const stale = await findStaleRefs(linesOf([
      "- Run `npm run test` before every commit here",
      "- Then run `npm run bundle` to produce the artifact",
    ].join("\n")), dir);
    expect(stale.map(s => s.ref)).toEqual(["npm run bundle"]);
    expect(stale[0].detail).toContain("bundle");
  });

  it("flags a missing make target and respects an existing one", async () => {
    const dir = await repo({ "Makefile": "test:\n\techo ok\n" });
    const stale = await findStaleRefs(linesOf([
      "- Use `make test` to run the whole suite locally",
      "- Use `make deploy` to push the service to production",
    ].join("\n")), dir);
    expect(stale.map(s => s.ref)).toEqual(["make deploy"]);
  });

  // An empty manifest means "not checkable", never "every target is missing".
  it("says nothing about scripts when there is no manifest to check against", async () => {
    const dir = await repo({});
    expect(await findStaleRefs(linesOf("- Run `npm run build` first thing every time"), dir)).toEqual([]);
  });

  it("never reports a reference in a user-scope instruction", async () => {
    const dir = await repo({});
    const lines = linesOf("- Build with `scripts/build.sh` before you commit", userSource);
    expect(await findStaleRefs(lines, dir)).toEqual([]);
  });

  it("never reports a path inside a fenced example", async () => {
    const dir = await repo({});
    const lines = linesOf([
      "```",
      "- edit scripts/example.sh to taste",
      "```",
    ].join("\n"));
    expect(await findStaleRefs(lines, dir)).toEqual([]);
  });

  it("holds its tongue on an illustrative path with no matching root", async () => {
    const dir = await repo({ "src/index.ts": "export {};\n" });
    // `foo/bar` has no extension and no existing root: far likelier an example
    // than a stale reference, so it is not worth the false positive.
    expect(await findStaleRefs(linesOf("- Put shared helpers in foo/bar somewhere"), dir)).toEqual([]);
    // `src/gone` has an existing root, so the location is real and its contents left.
    const stale = await findStaleRefs(linesOf("- Put shared helpers in `src/gone` somewhere"), dir);
    expect(stale.map(s => s.ref)).toEqual(["src/gone"]);
    // Unmarked, the same words are prose: "src/gone" could be "test/CI".
    expect(await findStaleRefs(linesOf("- Put shared helpers in src/gone somewhere"), dir)).toEqual([]);
  });

  it("ignores build output and paths that escape the project", async () => {
    const dir = await repo({});
    expect(await findStaleRefs(linesOf([
      "- Generated output lands in `dist/bundle.js` after a build",
      "- Shared config lives in `../sibling/config.json` for now",
    ].join("\n")), dir)).toEqual([]);
  });
});

describe("a path inside a backticked command", () => {
  /**
   * `isPathShaped` rejects anything with a space, and a backticked span is
   * pushed whole so `npm run build` can be matched as a script. Between those
   * two, "Run `node scripts/build.mjs` first" — one of the commonest shapes a
   * CLAUDE.md takes — was invisible to the one family whose job is keeping
   * those lines true. Found by pointing gradient at a repository that had
   * deleted exactly such a script.
   */
  it("is extracted, so a deleted script in a command is still caught", () => {
    expect(extractRefs("Run `node scripts/build-everything.mjs` before every commit."))
      .toContain("scripts/build-everything.mjs");
  });

  it("still extracts the whole span, so script references keep working", () => {
    expect(extractRefs("Run `npm run build` first")).toContain("npm run build");
  });

  // Precision is the point of this family: a false positive proposes deleting a
  // correct instruction. These look like paths and are not.
  it("does not turn command arguments into references to files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-stale-"));
    for (const text of [
      "Check `git log --oneline origin/main` before merging.",
      "Normalise with `sed s/foo/bar/ input.txt`.",
      "Compare against `origin/release-2.0` only.",
    ]) {
      const refs = extractRefs(text);
      const concrete = await findStaleRefs(
        [{ text, source: { scope: "project", path: join(dir, "CLAUDE.md"), assistant: "claude-code" } }] as never,
        dir,
      );
      expect({ text, flagged: concrete.map(r => r.ref) }).toEqual({ text, flagged: [] });
      expect(refs.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Shapes from real instruction files. A sweep of 47 local repositories turned
 * up 125 "gone" references, most of them present: link labels read as paths,
 * paths written from a subdirectory, build output, placeholders. Each case here
 * is one of those lines, reduced.
 */
describe("real instruction files", () => {
  async function checkout(files: Record<string, string>, name?: string): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), "grad-stale-real-"));
    const dir = join(parent, name ?? "repo");
    await mkdir(dir);
    for (const [file, content] of Object.entries(files)) {
      const full = join(dir, file);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
    execFileSync("git", ["init", "-q"], { cwd: dir });
    return dir;
  }
  const at = (dir: string, file = "CLAUDE.md"): InstructionSource => ({ ...source, path: join(dir, file) });
  const flagged = async (dir: string, text: string, file?: string) =>
    (await findStaleRefs(linesOf(text, at(dir, file)), dir)).map(ref => ref.ref);

  it("reads a markdown link as its target, not its label", async () => {
    const dir = await checkout({ ".agents/skills/upgrade/SKILL.md": "x", "docs/architecture.md": "x" });
    expect(extractRefs("Record it in an [upgrade guide](.agents/skills/upgrade/SKILL.md).")).toEqual([".agents/skills/upgrade/SKILL.md"]);
    expect(await flagged(dir, "Record it in an [upgrade guide](.agents/skills/upgrade/SKILL.md).")).toEqual([]);
    expect(await flagged(dir, "Read [docs/architecture.md](docs/architecture.md#layers) first.")).toEqual([]);
    expect(await flagged(dir, "See the [old guide](docs/gone.md).")).toEqual(["docs/gone.md"]);
  });

  it("strips an import marker and a line number before looking", async () => {
    const dir = await checkout({ "packages/testing/AGENTS.md": "x", "src/channel.ts": "x" });
    expect(await flagged(dir, "For test cleanup, see @packages/testing/AGENTS.md")).toEqual([]);
    expect(await flagged(dir, "Cite code as `src/channel.ts:80`.")).toEqual([]);
  });

  it("finds a path written from a subdirectory or beside a nested instruction file", async () => {
    const dir = await checkout({
      "webapp/src/lib/auth.ts": "x",
      "packages/playwright/composables/TestEntry.ts": "x",
    });
    expect(await flagged(dir, "- `src/lib/auth.ts` — getUser, requireAuth")).toEqual([]);
    expect(await flagged(dir, "Start from `composables/TestEntry.ts`.", "packages/playwright/AGENTS.md")).toEqual([]);
  });

  it("leaves build output and local files git ignores alone", async () => {
    const dir = await checkout({ ".gitignore": "graphify-out/\n.env.local\n", "webapp/.gitkeep": "" });
    expect(await flagged(dir, "Read graphify-out/GRAPH_REPORT.md before answering.")).toEqual([]);
    expect(await flagged(dir, "Run the webapp with `webapp/.env.local`.")).toEqual([]);
    await writeFile(join(dir, ".gitignore"), ".local/\n");
    expect(await flagged(dir, "Put local notes under `.local/prd/`; `.local/` is ignored.")).toEqual([]);
  });

  it("does not read an API route beside a real directory as a lost one", async () => {
    const dir = await checkout({ "gateway/app/main.py": "x" });
    expect(await flagged(dir, "Webapp streams POST to `gateway/api/chat` with a JWT")).toEqual([]);
  });

  it("does not read placeholders, examples, or prose slashes as files", async () => {
    const dir = await checkout({ "tests/ci/real.py": "x", "memory/.gitkeep": "", "docs/x.md": "x", "test/a.ts": "x" });
    expect(await flagged(dir, "Run one test: `uv run pytest tests/ci/test_specific_test.py`")).toEqual([]);
    expect(await flagged(dir, "Run one test: `pnpm test path/to/test-file.test.ts`")).toEqual([]);
    expect(await flagged(dir, "Log daily activity to `memory/YYYY-MM-DD.md`:")).toEqual([]);
    expect(await flagged(dir, "File references are repo-relative (example: `tests/ci/channel.ts:80`).")).toEqual([]);
    expect(await flagged(dir, "Docs/changelog-only changes: check docs/workflow and test/CI sanity.")).toEqual([]);
  });

  it("does not follow a sibling repository whose name extends this one's", async () => {
    const dir = await checkout({ "src/a.ts": "x" }, "openclaw");
    expect(await flagged(dir, "Installers live in the sibling repo `../openclaw.ai`.")).toEqual([]);
  });

  it("knows a workspace package's scripts", async () => {
    const dir = await checkout({
      "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
      "packages/client/package.json": JSON.stringify({ scripts: { generate: "gen" } }),
    });
    expect(await flagged(dir, "After changing the API, run `bun run generate` from `packages/client`.")).toEqual([]);
    expect(await flagged(dir, "Then `npm run gone`.")).toEqual(["npm run gone"]);
  });

  it("never runs a command the repository's git config names", async () => {
    const dir = await checkout({ "src/a.ts": "x" });
    const marker = join(dir, "..", "fsmonitor-ran");
    execFileSync("git", ["config", "core.fsmonitor", `touch '${marker}'; false`], { cwd: dir });
    await flagged(dir, "See `src/gone.ts`.");
    await expect(lstat(marker)).rejects.toThrow();
  });

  it("looks inside submodules", async () => {
    const fork = await checkout({ "src/agents/run/attempt.ts": "x" }, "fork");
    execFileSync("git", ["add", "-A"], { cwd: fork });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fork"], { cwd: fork });
    const dir = await checkout({ "src/a.ts": "x" });
    execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", fork, "fork"], { cwd: dir });
    expect(await flagged(dir, "The fork applies it in `run/attempt.ts`.")).toEqual([]);
  });

  it("still catches a directory that moved", async () => {
    const dir = await checkout({ "packages/frontend/editor-ui/src/main.ts": "x" });
    expect(await flagged(dir, "- **`packages/editor-ui`**: Vue 3 frontend application")).toEqual(["packages/editor-ui"]);
  });
});
