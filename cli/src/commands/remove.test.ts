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

describe("remove Codex block rules", () => {
  const rule = (id: string, name: string, text: string): Suggestion => ({
    id, name, title: "t", rationale: "r",
    evidence: { count: 4, sessions: 3 }, confidence: "high",
    payload: { type: "rule", target: "project", ruleName: name, text },
  });

  // A Codex rule has no file of its own — it is one line inside a file the user
  // also writes in. Every other artifact type is removed by unlinking its path,
  // so without a splice branch the first removal would delete the whole
  // AGENTS.md, hand-written team policy and all.
  it("splices out its own line and leaves the user's AGENTS.md standing", async () => {
    const proj = await mkdtemp(join(tmpdir(), "grad-rm-block-"));
    const home = await mkdtemp(join(tmpdir(), "grad-rm-home-"));
    const original = "# AGENTS.md\n\n## Team policy\n\n- Never force-push to main.\n";
    await writeFile(join(proj, "AGENTS.md"), original);

    await applySuggestion(rule("blk1", "prefer-pnpm", "Use pnpm without asking."), proj, {
      home, targets: ["codex"],
    });
    expect(await readFile(join(proj, "AGENTS.md"), "utf8")).toContain("Use pnpm without asking.");

    expect(await remove(proj, "prefer-pnpm", { home })).toBe(true);
    const after = await readFile(join(proj, "AGENTS.md"), "utf8");
    expect(after).toContain("Never force-push to main.");
    expect(after).toContain("## Team policy");
    expect(after).not.toContain("Use pnpm without asking.");
    expect(after).not.toContain("gradient:blk1");
    // The section gradient added goes with its last entry.
    expect(after).not.toContain("## gradient");
  });

  it("keeps the section while another gradient rule still lives in it", async () => {
    const proj = await mkdtemp(join(tmpdir(), "grad-rm-block2-"));
    const home = await mkdtemp(join(tmpdir(), "grad-rm-home-"));
    await applySuggestion(rule("blk1", "prefer-pnpm", "Use pnpm without asking."), proj, {
      home, targets: ["codex"],
    });
    await applySuggestion(rule("blk2", "no-comments", "Do not add explanatory comments."), proj, {
      home, targets: ["codex"],
    });

    expect(await remove(proj, "prefer-pnpm", { home })).toBe(true);
    const after = await readFile(join(proj, "AGENTS.md"), "utf8");
    expect(after).toContain("## gradient");
    expect(after).toContain("Do not add explanatory comments.");
    expect(after).not.toContain("Use pnpm without asking.");
  });
});
