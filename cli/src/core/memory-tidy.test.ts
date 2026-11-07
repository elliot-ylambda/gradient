import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkedNames, loadMemoryNotes } from "./memory-tidy.js";

async function memoryDir(notes: Record<string, string>, index: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-tidy-"));
  await writeFile(join(dir, "MEMORY.md"), index);
  for (const [name, body] of Object.entries(notes)) await writeFile(join(dir, name), body);
  return join(dir, "MEMORY.md");
}

const note = (description: string, type?: string) =>
  `---\nname: n\ndescription: "${description}"\n${type ? `metadata:\n  type: ${type}\n` : ""}---\n\nBody.\n`;

describe("auto-memory notes", () => {
  it("reads links from the index by file name, whatever the folder they are written with", () => {
    expect([...linkedNames("- [a](feedback_a.md) — x\n- [b](./sub/project_b.md)\n- not a link.md")])
      .toEqual(["feedback_a.md", "project_b.md"]);
  });

  it("types notes by prefix or declared type, and marks which ones the index links", async () => {
    const index = "# Memory\n- [Tests](feedback_tests.md)\n";
    const indexPath = await memoryDir({
      "feedback_tests.md": note("Run the full suite before pushing"),
      "release-steps.md": note("Release steps for the fleet", "reference"),
      "scratch.md": "no frontmatter at all",
    }, index);
    const notes = (await loadMemoryNotes(indexPath, index))!.notes;
    expect(notes.map(n => [n.name, n.type, n.linked])).toEqual([
      ["feedback_tests.md", "feedback", true],
      ["release-steps.md", "reference", false],
      ["scratch.md", "other", false],
    ]);
    expect(notes[0].description).toBe("Run the full suite before pushing");
  });
});
