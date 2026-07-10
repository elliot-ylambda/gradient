import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint } from "./checkpoint.js";

describe("checkpoint", () => {
  it("writes a private cached progress.md from redacted recent prompts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const path = await checkpoint(
      { transcript_path: "ignored.jsonl" },
      dir,
      async () => [
        { ts: "t1", project: "x", role: "user", text: "implement the parser", sessionId: "s" },
        { ts: "t2", project: "x", role: "user", text: "now add tests", sessionId: "s" },
        { ts: "t3", project: "x", role: "user", text: `deploy with npm_${"a".repeat(36)}`, sessionId: "s" },
      ],
    );
    expect(path).toBe(join(dir, ".gradient", "progress.md"));
    const md = await readFile(path, "utf8");
    expect(md).toContain("now add tests");
    expect(md).toContain("# Progress checkpoint");
    expect(md).toContain("[REDACTED]");
    expect(md).not.toContain(`npm_${"a".repeat(36)}`);
  });
});
