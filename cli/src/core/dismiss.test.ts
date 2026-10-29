import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Suggestion } from "./types.js";
import { addDismissal, dismissedPath, isDismissed, loadDismissed } from "./dismiss.js";

function suggestion(id: string, signatures?: string[]): Suggestion {
  return {
    id,
    name: `habit-${id}`,
    title: "Habit",
    rationale: "Observed",
    evidence: { count: 3, sessions: 2 },
    confidence: "high",
    ...(signatures ? { sourceSignatures: signatures } : {}),
    payload: { type: "command", commandName: `habit-${id}`, body: "Do it" },
  };
}

describe("dismissals", () => {
  it("suppresses a signature subset but resurfaces genuinely new evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-dismiss-"));
    const original = suggestion("one", ["lgtm", "looks good"]);
    await addDismissal(dir, original, new Date("2026-07-18T12:00:00Z"));
    const dismissed = await loadDismissed(dir);

    expect(isDismissed(suggestion("renamed", ["lgtm"]), dismissed)).toBe(true);
    expect(isDismissed(suggestion("expanded", ["lgtm", "looks good", "ship it"]), dismissed)).toBe(false);
  });

  it("falls back to stable id equality for old suggestions without signatures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-dismiss-"));
    await addDismissal(dir, suggestion("legacy"));
    const dismissed = await loadDismissed(dir);
    expect(isDismissed(suggestion("legacy"), dismissed)).toBe(true);
    expect(isDismissed(suggestion("other"), dismissed)).toBe(false);
  });

  it("treats corrupt or invalid state as empty without rewriting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-dismiss-"));
    const path = dismissedPath(dir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json");
    expect(await loadDismissed(dir)).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("{not json");
  });

  it("deduplicates repeated dismissals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-dismiss-"));
    const item = suggestion("one", ["lgtm"]);
    await addDismissal(dir, item, new Date("2026-07-17T00:00:00Z"));
    await addDismissal(dir, item, new Date("2026-07-18T00:00:00Z"));
    const dismissed = await loadDismissed(dir);
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0].dismissedAt).toBe("2026-07-18T00:00:00.000Z");
  });
});

import { dismissFinding, isFindingDismissed, loadFindingDismissals } from "./dismiss.js";
import type { Family, Finding } from "./findings.js";

describe("finding-level decisions", () => {
  const families: Family[] = ["drift", "stale", "skill-health", "dead-letter", "workflow", "practice", "memory"];
  it.each(families)("persists a %s dismissal only while its evidence is unchanged", async family => {
    const home = await mkdtemp(join(tmpdir(), "gradient-dismiss-home-"));
    const project = await mkdtemp(join(tmpdir(), "gradient-dismiss-project-"));
    const finding: Finding = { id: "abcdef123456", family, severity: "low", title: "Review this evidence",
      detail: "Details", evidence: "observed version one", targets: ["claude-code"], deterministic: false,
      commandBearing: false, changes: [] };
    await dismissFinding(project, finding, home);
    const entries = await loadFindingDismissals(project, home);
    expect(isFindingDismissed(finding, entries)).toBe(true);
    expect(isFindingDismissed({ ...finding, evidence: "materially changed evidence" }, entries)).toBe(false);
  });
});
