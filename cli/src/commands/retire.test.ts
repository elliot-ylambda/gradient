import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireRecall } from "./retire.js";
import { loadConfig, projectCacheDir, saveConfig } from "../config.js";
import { hookInstalled, installHook } from "../core/settings.js";

const temp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

describe("retireRecall", () => {
  it("removes the leftover hook, the consent record, and the derived index", async () => {
    const dir = await temp("grad-retire-");
    const home = await temp("grad-retire-home-");
    await saveConfig({ recallProjects: [dir], continuityProjects: [dir] } as Record<string, unknown>, home);
    await installHook(dir, "UserPromptSubmit", "gradient recall", { timeout: 5 });
    const cache = projectCacheDir(dir, home);
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "recall.json"), "{}");
    await writeFile(join(cache, "recall.adoption.jsonl"), "{}\n");

    await retireRecall(dir, home);

    expect(await hookInstalled(dir, "UserPromptSubmit", "gradient recall")).toBe(false);
    const config = await loadConfig(home) as Record<string, unknown>;
    expect(config.recallProjects).toBeUndefined();
    // Consent for a feature that still exists is untouched — retirement must
    // not read as permission to reset the user's other choices.
    expect(config.continuityProjects).toEqual([dir]);
    await expect(readFile(join(cache, "recall.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(cache, "recall.adoption.jsonl"), "utf8")).rejects.toThrow();
  });

  it("leaves other hooks on the same event in place", async () => {
    const dir = await temp("grad-retire-other-");
    const home = await temp("grad-retire-other-home-");
    await installHook(dir, "UserPromptSubmit", "gradient recall", { timeout: 5 });
    await installHook(dir, "UserPromptSubmit", "some-other-tool check", { timeout: 5 });

    await retireRecall(dir, home);

    expect(await hookInstalled(dir, "UserPromptSubmit", "gradient recall")).toBe(false);
    expect(await hookInstalled(dir, "UserPromptSubmit", "some-other-tool check")).toBe(true);
  });

  it("succeeds on a project that never had it", async () => {
    const dir = await temp("grad-retire-clean-");
    const home = await temp("grad-retire-clean-home-");
    await expect(retireRecall(dir, home)).resolves.toBeUndefined();
  });

  it("removes a hook installed under any binary form", async () => {
    const dir = await temp("grad-retire-form-");
    const home = await temp("grad-retire-form-home-");
    await installHook(dir, "UserPromptSubmit", "npx -y gradient.md@0.6.1 recall", { timeout: 5 });

    await retireRecall(dir, home);

    expect(await hookInstalled(dir, "UserPromptSubmit", "npx -y gradient.md@0.6.1 recall")).toBe(false);
  });
});
