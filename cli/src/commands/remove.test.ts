import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySuggestion } from "../core/apply.js";
import type { Suggestion } from "../core/types.js";
import { remove } from "./remove.js";

describe("remove playbook entries", () => {
  it("deletes exactly the tagged line and re-pins, never unlinking gradient.md", async () => {
    const proj = await mkdtemp(join(tmpdir(), "grad-rm-pb-"));
    const home = await mkdtemp(join(tmpdir(), "grad-rm-home-"));
    const suggestion: Suggestion = {
      id: "abc123", name: "pb-build-after-tests", title: "t", rationale: "r",
      evidence: { count: 4, sessions: 3 }, confidence: "high",
      payload: { type: "project-playbook", section: "workflows", text: "After tests pass, run make build." },
    };
    await writeFile(join(proj, "gradient.md"), "## Rules\n- hand rule\n\n## Workflows\n");
    await applySuggestion(suggestion, proj, { home });
    expect(await remove(proj, "pb-build-after-tests", { home })).toBe(true);
    const content = await readFile(join(proj, "gradient.md"), "utf8");
    expect(content).not.toContain("gradient:abc123");
    expect(content).toContain("- hand rule");
    const { loadPlaybookPin, loadProjectPlaybook, pinState } = await import("../core/playbook.js");
    expect(pinState(await loadProjectPlaybook(proj), await loadPlaybookPin(proj, home))).toBe("pinned");
  });
});
