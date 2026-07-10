import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBinary } from "./bin.js";
import { saveRecallIndex } from "./core/recall.js";

describe("binary bootstrap", () => {
  it("uses the lightweight recall path for exact hook invocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-bin-recall-"));
    await saveRecallIndex(dir, {
      builtAt: new Date(Date.now() + 3_600_000).toISOString(),
      entries: [{
        name: "ship",
        kind: "skill",
        invocation: "/ship",
        triggers: ["prepare this pull request for shipping"],
        signature: "",
        description: "",
      }],
    });
    const output: string[] = [];
    const code = await runBinary(["recall"], {
      readStdin: async () => ({ prompt: "prepare this pull request for shipping", cwd: dir }),
      write: chunk => output.push(chunk),
    });
    expect(code).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: expect.stringContaining('"/ship"'),
      },
    });
  });

  it("delegates normal commands to the full CLI", async () => {
    const output: string[] = [];
    expect(await runBinary(["--version"], { write: chunk => output.push(chunk) })).toBe(0);
    expect(output.join("").trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
