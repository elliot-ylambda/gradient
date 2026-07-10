import { describe, expect, it, vi } from "vitest";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule, runBinary } from "./bin.js";
import { saveRecallIndex } from "./core/recall.js";
import { notify } from "./commands/notify.js";

vi.mock("./commands/notify.js", () => ({ notify: vi.fn(async () => {}) }));

describe("binary bootstrap", () => {
  it("recognizes an npm-style symlink as the main module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-bin-symlink-"));
    const target = join(dir, "dist-bin.js");
    const link = join(dir, "gradient");
    await writeFile(target, "");
    await symlink(target, link);

    expect(isMainModule(pathToFileURL(target).href, link)).toBe(true);
  });

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

  it("uses a silent lightweight path for the notification hook", async () => {
    vi.mocked(notify).mockClear();
    const output: string[] = [];
    let drained = false;
    const code = await runBinary(["notify"], {
      readStdin: async () => {
        drained = true;
        return { ignored: true };
      },
      write: chunk => output.push(chunk),
    });
    expect(code).toBe(0);
    expect(drained).toBe(true);
    expect(vi.mocked(notify)).toHaveBeenCalledOnce();
    expect(output).toEqual([]);
  });

  it("delegates normal commands to the full CLI", async () => {
    const output: string[] = [];
    expect(await runBinary(["--version"], { write: chunk => output.push(chunk) })).toBe(0);
    expect(output.join("").trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
