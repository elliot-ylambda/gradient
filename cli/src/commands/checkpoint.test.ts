import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint } from "./checkpoint.js";

describe("checkpoint", () => {
  it("writes a progress.md from recent user prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const path = await checkpoint(
      { transcript_path: "ignored.jsonl" },
      dir,
      async () => [
        { ts: "t1", project: "x", role: "user", text: "implement the parser", sessionId: "s" },
        { ts: "t2", project: "x", role: "user", text: "now add tests", sessionId: "s" },
      ],
    );
    expect(path).toBe(join(dir, "progress.md"));
    const md = await readFile(path, "utf8");
    expect(md).toContain("now add tests");
    expect(md).toContain("# Progress checkpoint");
  });
});
