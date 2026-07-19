import { beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setContinuity, continuityStatus } from "./continuity.js";
import { recap } from "./recap.js";
import { installHook } from "../core/settings.js";
import { progressPath } from "./checkpoint.js";

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-cont-"));
  home = await mkdtemp(join(tmpdir(), "grad-home-"));
});

describe("continuity", () => {
  it("installs both hooks and removes only those hooks", async () => {
    await setContinuity(true, dir, { home });
    const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.local.json"), "utf8"));
    expect(JSON.stringify(settings.hooks.PreCompact)).toContain("gradient checkpoint");
    expect(settings.hooks.SessionStart[0]).toMatchObject({ matcher: "resume|compact" });
    expect(await continuityStatus(dir, { home })).toEqual({ checkpoint: true, recap: true });
    await installHook(dir, "SessionStart", "other startup", { matcher: "startup" });
    await setContinuity(false, dir, { home });
    expect(await continuityStatus(dir, { home })).toEqual({ checkpoint: false, recap: false });
    expect(await readFile(join(dir, ".claude", "settings.local.json"), "utf8")).toContain("other startup");
  });

  it("on is idempotent and repairs a missing matcher", async () => {
    await setContinuity(true, dir, { home });
    const path = join(dir, ".claude", "settings.local.json");
    const settings = JSON.parse(await readFile(path, "utf8"));
    delete settings.hooks.SessionStart[0].matcher;
    await writeFile(path, JSON.stringify(settings));
    expect((await continuityStatus(dir, { home })).recap).toBe(false);
    await setContinuity(true, dir, { home });
    const repaired = JSON.parse(await readFile(path, "utf8"));
    expect(repaired.hooks.SessionStart).toHaveLength(1);
    expect(repaired.hooks.SessionStart[0].matcher).toBe("resume|compact");
  });
});

describe("recap", () => {
  it("returns progress.md content and null when absent", async () => {
    expect(await recap(dir, { home })).toBeNull();
    await mkdir(dirname(progressPath(dir, home)), { recursive: true });
    await writeFile(progressPath(dir, home), "# Progress checkpoint\nstuff");
    expect(await recap(dir, { home })).toBeNull(); // consent has not been granted in this test
    await setContinuity(true, dir, { home });
    await writeFile(progressPath(dir, home), "# Progress checkpoint\nstuff");
    const output = await recap(dir, { home });
    expect(output).toContain("stuff");
    expect(output).toContain("untrusted data");
    await setContinuity(false, dir, { home });
    await expect(readFile(progressPath(dir, home), "utf8")).rejects.toThrow();
  });

  it("treats committed or stale hooks as inert without private consent", async () => {
    await installHook(dir, "PreCompact", "gradient checkpoint");
    await installHook(dir, "SessionStart", "gradient recap", { matcher: "resume|compact" });
    expect(await continuityStatus(dir, { home })).toEqual({ checkpoint: false, recap: false });
  });
});
