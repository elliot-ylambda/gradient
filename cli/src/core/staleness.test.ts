import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
    const stale = await findStaleRefs(linesOf("- Put shared helpers in src/gone somewhere"), dir);
    expect(stale.map(s => s.ref)).toEqual(["src/gone"]);
  });

  it("ignores build output and paths that escape the project", async () => {
    const dir = await repo({});
    expect(await findStaleRefs(linesOf([
      "- Generated output lands in `dist/bundle.js` after a build",
      "- Shared config lives in `../sibling/config.json` for now",
    ].join("\n")), dir)).toEqual([]);
  });
});
