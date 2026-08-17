import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SKILLS, codexName, forCodex } from "../scripts/skill-render.mjs";
import { VERSION } from "./version.js";
import { parseFrontmatter, scalar } from "./core/frontmatter.js";
import { DESCRIPTION_CAP, loadSurface } from "./core/surface.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const codexDir = (name: string) => join(repoRoot, "skills", codexName(name));
const read = (path: string) => readFileSync(path, "utf8");

/**
 * A Codex user installs gradient by copying these directories into
 * ~/.agents/skills — there is no installer to fix anything up afterwards, so
 * what is committed here is exactly what runs. That makes every property below
 * a shipping property, not a style preference.
 */
describe("the copy-installed Codex skills", () => {
  it("ships one directory per plugin skill, prefixed to own a name in a flat namespace", () => {
    const present = readdirSync(join(repoRoot, "skills")).filter(entry => entry.startsWith("gradient-"));
    expect(present.sort()).toEqual(SKILLS.map(codexName).sort());
  });

  // The guard on the whole scheme: the plugin's SKILL.md is the source, and
  // re-deriving it has to be a no-op. Without this, an edit to either copy
  // silently makes the two assistants behave differently.
  it("is exactly what re-deriving from the plugin source produces", () => {
    for (const name of SKILLS) {
      const source = read(join(repoRoot, "plugin", "skills", name, "SKILL.md"));
      expect(read(join(codexDir(name), "SKILL.md")))
        .toBe(forCodex(source, name));
    }
  });

  it("carries the same bundle the plugin runs, byte for byte", () => {
    const plugin = readFileSync(join(repoRoot, "plugin", "bin", "gradient.mjs"));
    for (const name of SKILLS) {
      expect(readFileSync(join(codexDir(name), "bin", "gradient.mjs")).equals(plugin)).toBe(true);
    }
  });

  it("invokes the runner in its own directory, and never a plugin variable Codex cannot expand", () => {
    for (const name of SKILLS) {
      const body = read(join(codexDir(name), "SKILL.md"));
      expect(body).toContain(`node "$HOME/.agents/skills/${codexName(name)}/bin/gradient.mjs"`);
      expect(body).not.toContain("CLAUDE_PLUGIN_ROOT");
      // No PATH fallback: nothing installs a `gradient` command any more.
      expect(body).not.toMatch(/(^|[^/])\bgradient (optimize|remove|on|off)\b/);
    }
  });

  /**
   * gradient reports a Claude-Code-only frontmatter key on a Codex skill as a
   * `non-portable-key` problem. A tool that ships an artifact it would flag has
   * no standing to flag anyone else's.
   */
  it("passes gradient's own inspection with no problems", async () => {
    // Install them the way the README says to, then look at what is there.
    const home = await mkdtemp(join(tmpdir(), "grad-skills-"));
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    for (const name of SKILLS) {
      await cp(join(codexDir(name), "SKILL.md"), join(home, ".agents", "skills", codexName(name), "SKILL.md"));
    }

    const surface = await loadSurface(await mkdtemp(join(tmpdir(), "grad-proj-")), ["codex"], { home });
    expect(surface.skills.map(skill => skill.name).sort()).toEqual(SKILLS.map(codexName).sort());
    for (const skill of surface.skills) expect(skill.problems).toEqual([]);
  });

  it("has a description within the listing cap on every skill", () => {
    for (const name of SKILLS) {
      const description = scalar(parseFrontmatter(read(join(codexDir(name), "SKILL.md"))), "description") ?? "";
      expect(description.length).toBeGreaterThan(40);
      expect(description.length).toBeLessThanOrEqual(DESCRIPTION_CAP);
    }
  });

  // The failure this catches is the whole reason the npx bootstrap existed: a
  // SKILL.md naming a command that does not resolve. Run it.
  it("names a runner that actually runs", () => {
    for (const name of SKILLS) {
      const result = spawnSync(process.execPath, [join(codexDir(name), "bin", "gradient.mjs"), "--version"], {
        encoding: "utf8", timeout: 15_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(VERSION);
    }
  });
});
