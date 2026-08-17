import { describe, expect, it, vi } from "vitest";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gradientHomeFromEnv, isEntrypoint, runBinary } from "./bin.js";
import { loadConfig, saveConfig } from "./config.js";
import { installHook, hookInstalled } from "./core/settings.js";
import { notify } from "./commands/notify.js";
import { sessionStart } from "./commands/sessionStart.js";

vi.mock("./commands/notify.js", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("./commands/sessionStart.js", () => ({ sessionStart: vi.fn(async (_dir, deps) => deps.write?.("surface")) }));

describe("binary bootstrap", () => {
  it("resolves an optional Gradient home without changing the default", () => {
    expect(gradientHomeFromEnv({})).toBeUndefined();
    expect(gradientHomeFromEnv({ GRADIENT_HOME: "   " })).toBeUndefined();
    expect(gradientHomeFromEnv({ GRADIENT_HOME: "/tmp/gradient-dogfood" }))
      .toBe("/tmp/gradient-dogfood");
    expect(gradientHomeFromEnv({ GRADIENT_HOME: "gradient-dogfood" }))
      .toBe(resolve("gradient-dogfood"));
  });

  it("recognizes npm's symlinked bin path as the entrypoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-bin-link-"));
    const target = join(dir, "bin.js");
    const link = join(dir, "gradient");
    await writeFile(target, "#!/usr/bin/env node\n");
    await symlink(target, link);
    expect(isEntrypoint(pathToFileURL(target).href, link)).toBe(true);
  });

  // `recall` is retired. A user who had it on still has a UserPromptSubmit hook
  // pointing at it, and that event's stdout is read as model context — so the
  // fast path must stay, stay silent, and take the hook with it.
  // `recall` ran on UserPromptSubmit, whose stdout is read as model context.
  // The verb is gone, but a stray settings entry reaching the unknown-command
  // handler would inject usage text into a live session, so the binary exits
  // silently on it rather than falling through.
  it("exits silently on a leftover recall hook instead of reaching the unknown-command handler", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-bin-recall-"));
    const home = await mkdtemp(join(tmpdir(), "grad-bin-home-"));

    const output: string[] = [];
    const code = await runBinary(["recall"], {
      readStdin: async () => ({ prompt: "anything at all", cwd: dir }),
      write: chunk => output.push(chunk),
      home,
      cwd: dir,
    });

    expect(code).toBe(0);
    expect(output.join("")).toBe("");
  });

  it("is idempotent when there is nothing left to retire", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-bin-recall-clean-"));
    const home = await mkdtemp(join(tmpdir(), "grad-bin-home-clean-"));
    const output: string[] = [];
    expect(await runBinary(["recall"], { write: chunk => output.push(chunk), home, cwd: dir })).toBe(0);
    expect(output.join("")).toBe("");
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

  it("uses the lightweight session-start path", async () => {
    vi.mocked(sessionStart).mockClear();
    const output: string[] = [];
    const code = await runBinary(["session-start"], {
      cwd: "/repo",
      write: chunk => output.push(chunk),
    });
    expect(code).toBe(0);
    expect(vi.mocked(sessionStart)).toHaveBeenCalledWith("/repo", expect.objectContaining({ write: expect.any(Function) }));
    expect(output).toEqual(["surface\n"]);
  });

  it("delegates normal commands to the full CLI", async () => {
    const output: string[] = [];
    expect(await runBinary(["--version"], { write: chunk => output.push(chunk) })).toBe(0);
    expect(output.join("").trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
