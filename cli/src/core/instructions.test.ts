import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractInstructionLines, loadInstructions } from "./instructions.js";

describe("extractInstructionLines", () => {
  it("keeps list items and short paragraph lines while stripping list markers", () => {
    const markdown = [
      "# Project",
      "",
      "- Always use pnpm, never npm.",
      "* Run `make dev` before testing.",
      "3. Keep PRs under 400 lines.",
      "",
      "Prefer small focused files.",
    ].join("\n");
    expect(extractInstructionLines(markdown)).toEqual([
      "Always use pnpm, never npm.",
      "Run `make dev` before testing.",
      "Keep PRs under 400 lines.",
      "Prefer small focused files.",
    ]);
  });

  it("skips metadata, code, comments, links, imports, and out-of-range lines", () => {
    const markdown = [
      "---",
      "paths: src/**/*.ts",
      "---",
      "## Rules",
      "```ts",
      "- not an instruction, it is code",
      "```",
      "~~~",
      "also not an instruction",
      "~~~",
      "| a | b |",
      "<!-- gradient:mined:start -->",
      "Never include this generated instruction.",
      "<!-- gradient:mined:end -->",
      "[Documentation](https://example.com)",
      "@README.md",
      "> quoted context",
      "ok?",
      "x".repeat(201),
    ].join("\n");
    expect(extractInstructionLines(markdown)).toEqual([]);
  });
});

describe("loadInstructions", () => {
  it("reads every supported source with correct tags and survives missing files", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-instructions-project-"));
    const home = await mkdtemp(join(tmpdir(), "grad-instructions-home-"));
    await writeFile(join(projectDir, "CLAUDE.md"), "- Use pnpm always here.");
    await writeFile(join(projectDir, "CLAUDE.local.md"), "- Local preference line here.");
    await mkdir(join(projectDir, ".claude", "rules"), { recursive: true });
    await writeFile(join(projectDir, ".claude", "rules", "style.md"), "- Two-space indent always.");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "CLAUDE.md"), "- Reply in English.");

    const lines = await loadInstructions(projectDir, home);
    expect(lines.map(line => line.source).sort()).toEqual(["project", "project-local", "rule", "user"]);
    expect(lines.find(line => line.source === "user")).toMatchObject({
      text: "Reply in English.",
      normalized: "reply in english",
    });
  });

  it("returns an empty list when no sources exist", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-instructions-project-"));
    const home = await mkdtemp(join(tmpdir(), "grad-instructions-home-"));
    expect(await loadInstructions(projectDir, home)).toEqual([]);
  });

  it("does not follow a repository-controlled rules symlink", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "grad-instructions-project-"));
    const home = await mkdtemp(join(tmpdir(), "grad-instructions-home-"));
    const outside = await mkdtemp(join(tmpdir(), "grad-instructions-outside-"));
    await writeFile(join(outside, "secret.md"), "- Never expose this outside instruction.");
    await mkdir(join(projectDir, ".claude"), { recursive: true });
    await symlink(outside, join(projectDir, ".claude", "rules"));
    expect(await loadInstructions(projectDir, home)).toEqual([]);
  });
});
