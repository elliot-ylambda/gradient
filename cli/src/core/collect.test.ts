import { describe, it, expect } from "vitest";
import { encodeProjectDir, matchesSince } from "./collect.js";

describe("collect helpers", () => {
  it("encodes a cwd to a projects dir name", () => {
    expect(encodeProjectDir("/Users/x/projects/y")).toBe("-Users-x-projects-y");
  });
  it("matchesSince keeps recent files and drops old ones", () => {
    const now = 1_000_000_000_000;
    const day = 86_400_000;
    expect(matchesSince(now - 2 * day, 7, now)).toBe(true);
    expect(matchesSince(now - 10 * day, 7, now)).toBe(false);
    expect(matchesSince(now - 999 * day, undefined, now)).toBe(true); // no filter
  });
});

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, encodeProjectDir } from "./collect.js";

describe("collect", () => {
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
});
