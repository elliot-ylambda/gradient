import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpoint } from "./checkpoint.js";
import { parseLines } from "../core/parse.js";

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

  it("includes a redacted recent tail section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const lines = [
      JSON.stringify({
        type: "user",
        sessionId: "s",
        message: { role: "user", content: "deploy with API_KEY=abc123secret" },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: "s",
        message: { role: "assistant", content: [{ type: "text", text: "Deployed to staging." }] },
      }),
    ];
    const path = await checkpoint(
      { transcript_path: "t" },
      dir,
      async () => parseLines(lines),
      async () => lines,
    );
    const markdown = await readFile(path, "utf8");
    expect(markdown).toContain("## Where things stood");
    expect(markdown).toContain("Deployed to staging.");
    expect(markdown).not.toContain("abc123secret");
  });
});
