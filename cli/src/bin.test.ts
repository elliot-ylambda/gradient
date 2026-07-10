import { describe, expect, it } from "vitest";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isEntrypoint, runBinary } from "./bin.js";
import { saveRecallIndex } from "./core/recall.js";
import { projectKey, saveConfig } from "./config.js";

describe("binary bootstrap", () => {
  it("recognizes npm's symlinked bin path as the entrypoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-bin-link-"));
    const target = join(dir, "bin.js");
    const link = join(dir, "gradient");
    await writeFile(target, "#!/usr/bin/env node\n");
    await symlink(target, link);
    expect(isEntrypoint(pathToFileURL(target).href, link)).toBe(true);
  });

  it("uses the lightweight recall path for exact hook invocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-bin-recall-"));
    const home = await mkdtemp(join(tmpdir(), "grad-bin-home-"));
    await saveConfig({ recallProjects: [projectKey(dir)] }, home);
    await saveRecallIndex(dir, {
      builtAt: new Date().toISOString(),
      entries: [{
        name: "ship", kind: "skill", invocation: "/ship",
        triggers: ["prepare this pull request for shipping"], signature: "", description: "",
      }],
    }, home);
    const output: string[] = [];
    const code = await runBinary(["recall"], {
      readStdin: async () => ({ prompt: "prepare this pull request for shipping", cwd: dir }),
      write: chunk => output.push(chunk),
      home,
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
