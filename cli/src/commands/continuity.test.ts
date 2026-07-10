import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setContinuity, continuityStatus } from "./continuity.js";
import { recap } from "./recap.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-cont-"));
});

describe("continuity", () => {
  it("installs both hooks and removes only those hooks", async () => {
    await setContinuity(true, dir);
    const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
    expect(JSON.stringify(settings.hooks.PreCompact)).toContain("gradient checkpoint");
    expect(settings.hooks.SessionStart[0]).toMatchObject({ matcher: "resume|compact" });
    expect(await continuityStatus(dir)).toEqual({ checkpoint: true, recap: true });
    await setContinuity(false, dir);
    expect(await continuityStatus(dir)).toEqual({ checkpoint: false, recap: false });
  });

  it("on is idempotent and repairs a missing matcher", async () => {
    await setContinuity(true, dir);
    const path = join(dir, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(path, "utf8"));
    delete settings.hooks.SessionStart[0].matcher;
    await writeFile(path, JSON.stringify(settings));
    expect((await continuityStatus(dir)).recap).toBe(false);
    await setContinuity(true, dir);
    const repaired = JSON.parse(await readFile(path, "utf8"));
    expect(repaired.hooks.SessionStart).toHaveLength(1);
    expect(repaired.hooks.SessionStart[0].matcher).toBe("resume|compact");
  });
});

describe("recap", () => {
  it("returns progress.md content and null when absent", async () => {
    expect(await recap(dir)).toBeNull();
    await writeFile(join(dir, "progress.md"), "# Progress checkpoint\nstuff");
    expect(await recap(dir)).toContain("stuff");
  });
});
