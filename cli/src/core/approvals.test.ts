import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  approvalLedgerPath,
  approvalMatches,
  loadArtifactApprovals,
  recordArtifactApproval,
  revokeArtifactApproval,
} from "./approvals.js";
import type { ManifestEntry } from "./types.js";

describe("artifact approval ledger", () => {
  it("stores exact-content approval privately outside the repository", async () => {
    const project = await mkdtemp(join(tmpdir(), "grad-approval-project-"));
    const home = await mkdtemp(join(tmpdir(), "grad-approval-home-"));
    const entry: ManifestEntry = {
      name: "ship", type: "skill", path: join(project, ".claude/skills/ship/SKILL.md"),
      createdAt: "2026-07-10", suggestionId: "suggestion-1",
    };
    await recordArtifactApproval(project, entry, "approved bytes\n", home);

    const ledger = await loadArtifactApprovals(project, home);
    expect(approvalMatches(ledger, entry, "approved bytes\n")).toBe(true);
    expect(approvalMatches(ledger, entry, "changed bytes\n")).toBe(false);
    expect(approvalLedgerPath(project, home).startsWith(home)).toBe(true);
    expect((await stat(approvalLedgerPath(project, home))).mode & 0o777).toBe(0o600);
  });

  it("ignores a repo-forged ledger and revokes local approval by name", async () => {
    const project = await mkdtemp(join(tmpdir(), "grad-approval-project-"));
    const home = await mkdtemp(join(tmpdir(), "grad-approval-home-"));
    const entry: ManifestEntry = {
      name: "ship", type: "skill", path: join(project, ".claude/skills/ship/SKILL.md"),
      createdAt: "2026-07-10", suggestionId: "suggestion-1",
    };
    const forged = join(project, ".gradient", "artifact-approvals.json");
    await mkdir(dirname(forged), { recursive: true });
    await writeFile(forged, JSON.stringify([{ name: "ship" }]));
    expect(await loadArtifactApprovals(project, home)).toEqual([]);

    await recordArtifactApproval(project, entry, "approved\n", home);
    await revokeArtifactApproval(project, "ship", home);
    expect(await loadArtifactApprovals(project, home)).toEqual([]);
    expect(await readFile(forged, "utf8")).toContain("ship");
  });
});
