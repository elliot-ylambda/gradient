import { beforeEach, describe, expect, it } from "vitest";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildBundle } from "./bundle.js";
import { addEntry, artifactMarker, removeEntries } from "./manifest.js";
import type { ArtifactType, ManifestEntry } from "./types.js";
import { recordArtifactApproval } from "./approvals.js";
import { VERSION } from "../version.js";

let dir: string;
let home: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-bun-"));
  home = await mkdtemp(join(tmpdir(), "grad-bun-home-"));
});

function pathFor(type: ArtifactType, name: string, target: "claude-code" | "codex" = "claude-code"): string {
  if (type === "skill" && target === "codex") return join(dir, ".agents", "skills", name, "SKILL.md");
  if (type === "skill") return join(dir, ".claude", "skills", name, "SKILL.md");
  if (type === "command") return join(dir, ".claude", "commands", `${name}.md`);
  if (type === "rule") return join(dir, ".claude", "rules", `gradient-${name}.md`);
  throw new Error("pathless type");
}

async function seedArtifact(
  type: "skill" | "command" | "rule",
  name: string,
  body = "body\n",
  approved = true,
  target: "claude-code" | "codex" = "claude-code",
): Promise<ManifestEntry> {
  const path = pathFor(type, name, target);
  const entry: ManifestEntry = {
    name, type, path, createdAt: "2026-07-01", suggestionId: `sig-${name}`,
    ...(target === "codex" ? { target } : {}),
  };
  const content = `${artifactMarker(entry)}\n${body}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await addEntry(dir, entry);
  if (approved) await recordArtifactApproval(dir, entry, content, home);
  return entry;
}

function bundle(name = "kit") {
  return buildBundle(dir, name, { home });
}

describe("buildBundle", () => {
  it("copies exact-content-approved skills into a current-version plugin shell", async () => {
    await seedArtifact("skill", "ship");
    const result = await bundle("Team Toolkit!");
    const plugin = JSON.parse(await readFile(join(result.dir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(plugin).toEqual({
      name: "team-toolkit",
      description: "Workflows mined from real usage by gradient",
      version: VERSION,
    });
    const skill = await readFile(join(result.dir, "skills", "ship", "SKILL.md"), "utf8");
    expect(skill).toContain("body");
    expect(skill).not.toContain("sig-ship");
    const readme = await readFile(join(result.dir, "README.md"), "utf8");
    expect(readme).toContain("Artifact text can quote or derive from redacted prompts");
    expect(await readFile(join(result.dir, ".gradient-bundle.json"), "utf8")).toContain('"generator": "gradient"');
    const codexManifest = JSON.parse(await readFile(join(result.dir, ".codex-plugin", "plugin.json"), "utf8"));
    expect(codexManifest).toMatchObject({
      name: "team-toolkit",
      version: VERSION,
      author: { name: "gradient" },
      skills: "./skills/",
      interface: {
        displayName: "team-toolkit",
        category: "Productivity",
      },
    });
  });

  it("deduplicates dual-target skills and prefers the portable Codex copy", async () => {
    await seedArtifact("skill", "ship", "claude body\n");
    await seedArtifact("skill", "ship", "portable body\n", true, "codex");
    const result = await bundle();
    expect(await readFile(join(result.dir, "skills", "ship", "SKILL.md"), "utf8")).toContain("portable body");
    expect(result.skipped).toEqual([]);
  });

  it("copies approved commands and rules only to explicit, non-auto-invoked locations", async () => {
    await seedArtifact("command", "ship", "legacy command\n");
    await seedArtifact("rule", "prefer-pnpm", "project rule\n");
    const result = await bundle();
    expect(await readFile(join(result.dir, "commands", "ship.md"), "utf8")).toContain("legacy command");
    expect(await readFile(join(result.dir, "rules", "gradient-prefer-pnpm.md"), "utf8")).toContain("project rule");
    await expect(access(join(result.dir, "skills", "ship", "SKILL.md"))).rejects.toThrow();
    expect(await readFile(join(result.dir, "README.md"), "utf8")).toContain("copy them manually");
  });

  it("skips pathless, missing, unmarked, sensitive, and legacy-unapproved artifacts", async () => {
    await addEntry(dir, { name: "a-loop", type: "loop", path: "", createdAt: "2026-07-01", suggestionId: "loop" });
    await addEntry(dir, {
      name: "ghost", type: "skill", path: pathFor("skill", "ghost"),
      createdAt: "2026-07-01", suggestionId: "ghost",
    });
    const unmarked = pathFor("skill", "unmarked");
    await mkdir(dirname(unmarked), { recursive: true });
    await writeFile(unmarked, "hand-written\n");
    await addEntry(dir, { name: "unmarked", type: "skill", path: unmarked, createdAt: "2026-07-01", suggestionId: "u" });
    await seedArtifact("skill", "secret", "API_KEY=abc123secret\n");
    await seedArtifact("skill", "legacy", "old model-authored body\n", false);

    const result = await bundle();
    expect(result.skipped.sort()).toEqual(["a-loop", "ghost", "legacy", "secret", "unmarked"]);
    expect(await readdir(result.dir)).not.toContain("suggestions.json");
  });

  it("skips an approved artifact after its exact bytes change", async () => {
    const entry = await seedArtifact("skill", "ship");
    await writeFile(entry.path, `${artifactMarker(entry)}\nchanged after approval\n`);
    const result = await bundle();
    expect(result.skipped).toContain("ship");
    await expect(access(join(result.dir, "skills", "ship", "SKILL.md"))).rejects.toThrow();
  });

  it("rejects an invalid manifest path without replacing a prior good bundle", async () => {
    await seedArtifact("skill", "ship");
    const first = await bundle();
    const prior = await readFile(join(first.dir, "skills", "ship", "SKILL.md"), "utf8");
    const secret = join(dir, "secret.txt");
    await writeFile(secret, "DO_NOT_BUNDLE");
    await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify([{
      name: "stolen", type: "skill", path: secret,
      createdAt: "2026-07-01", suggestionId: "evil",
    }]));

    await expect(bundle()).rejects.toThrow(/path/);
    expect(await readFile(secret, "utf8")).toBe("DO_NOT_BUNDLE");
    expect(await readFile(join(first.dir, "skills", "ship", "SKILL.md"), "utf8")).toBe(prior);
  });

  it("rebuilds from scratch so removed artifacts cannot remain stale", async () => {
    await seedArtifact("skill", "ship");
    const first = await bundle();
    const bundledSkill = join(first.dir, "skills", "ship", "SKILL.md");
    await expect(access(bundledSkill)).resolves.toBeUndefined();
    await removeEntries(dir, "ship");
    await bundle();
    await expect(access(bundledSkill)).rejects.toThrow();
  });

  it("writes a valid shell for an empty manifest", async () => {
    const result = await bundle();
    expect(result.files.some(file => file.endsWith("plugin.json"))).toBe(true);
    expect(result.skipped).toEqual([]);
  });

  it("disables hook export until recipients have their own consent boundary", async () => {
    await expect(buildBundle(dir, "kit", { withHooks: true, home })).rejects.toThrow(/recipient-side consent/);
  });

  it("refuses a symlinked bundle ancestor without touching its victim", async () => {
    const outside = await mkdtemp(join(tmpdir(), "grad-bundle-victim-"));
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(outside, join(dir, ".gradient"));
    await expect(bundle()).rejects.toThrow(/symlink/);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("skips a symlinked artifact without reading its settings-file victim", async () => {
    const settings = join(dir, ".claude", "settings.local.json");
    const skill = pathFor("skill", "stolen-settings");
    const entry: ManifestEntry = {
      name: "stolen-settings", type: "skill", path: skill,
      createdAt: "2026-07-01", suggestionId: "stolen",
    };
    await mkdir(dirname(skill), { recursive: true });
    await writeFile(settings, "TOP_SECRET_SETTINGS");
    await symlink(settings, skill);
    await addEntry(dir, entry);
    const result = await bundle();
    expect(result.skipped).toContain("stolen-settings");
    expect(await readFile(settings, "utf8")).toBe("TOP_SECRET_SETTINGS");
    expect((await readFile(join(result.dir, "README.md"), "utf8"))).not.toContain("TOP_SECRET_SETTINGS");
  });

  it("does not export a Codex skill through a symlinked .agents root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "grad-codex-victim-"));
    const path = join(outside, "skills", "ship", "SKILL.md");
    const entry: ManifestEntry = {
      name: "ship", type: "skill", target: "codex",
      path: join(dir, ".agents", "skills", "ship", "SKILL.md"),
      createdAt: "2026-07-01", suggestionId: "sig-ship",
    };
    const content = `${artifactMarker(entry)}\nPRIVATE_VICTIM_TEXT\n`;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    await symlink(outside, join(dir, ".agents"));
    await addEntry(dir, entry);
    await recordArtifactApproval(dir, entry, content, home);
    const result = await bundle();
    expect(result.skipped).toContain("ship");
    await expect(access(join(result.dir, "skills", "ship", "SKILL.md"))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toContain("PRIVATE_VICTIM_TEXT");
  });

  it("caps aggregate source bytes and preserves the prior bundle", async () => {
    const first = await bundle();
    const priorReadme = await readFile(join(first.dir, "README.md"), "utf8");
    for (let i = 0; i < 9; i++) {
      await seedArtifact("skill", `large-${i}`, "a".repeat(240_000));
    }
    await expect(bundle()).rejects.toThrow(/byte cap/);
    expect(await readFile(join(first.dir, "README.md"), "utf8")).toBe(priorReadme);
  });

  it("preserves the prior bundle when writing the replacement fails", async () => {
    await seedArtifact("skill", "ship");
    const first = await bundle();
    const prior = await readFile(join(first.dir, "skills", "ship", "SKILL.md"), "utf8");
    const parent = join(dir, ".gradient", "bundle");
    await chmod(parent, 0o500);
    try {
      await expect(bundle()).rejects.toThrow();
      expect(await readFile(join(first.dir, "skills", "ship", "SKILL.md"), "utf8")).toBe(prior);
    } finally {
      await chmod(parent, 0o700);
    }
  });

  it("refuses to replace an unowned existing target", async () => {
    const target = join(dir, ".gradient", "bundle", "kit");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "keep.txt"), "user content");
    await expect(bundle()).rejects.toThrow(/ownership metadata/);
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("user content");
  });
});
