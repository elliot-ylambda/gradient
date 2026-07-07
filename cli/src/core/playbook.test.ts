import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  generatePlaybook, writePlaybook, loadPlaybook, playbookPath,
  isNudge, DEFAULT_PLAYBOOK, MINED_START, MINED_END,
} from "./playbook.js";
import type { Suggestion } from "./types.js";

const sugg = (over: Partial<Suggestion> & { payload: Suggestion["payload"] }): Suggestion => ({
  id: "id1", name: "continue-loop", title: "Keep going until done",
  rationale: "r", evidence: { count: 150, sessions: 44 }, confidence: "high",
  ...over,
});

const nudge = sugg({ payload: { type: "loop", instruction: "continue until actually done" } });
const scheduled = sugg({ name: "daily-triage", payload: { type: "loop", instruction: "triage issues", cadence: "0 9 * * *" } });
const command = sugg({ id: "id2", name: "ship", title: "Push, open a PR, review it", payload: { type: "command", commandName: "ship", body: "b" } });

describe("isNudge", () => {
  it("is true only for cadence-less loop suggestions", () => {
    expect(isNudge(nudge)).toBe(true);
    expect(isNudge(scheduled)).toBe(false);
    expect(isNudge(command)).toBe(false);
  });
});

describe("generatePlaybook", () => {
  it("fills the mined region of the default template", () => {
    const out = generatePlaybook([nudge, scheduled, command]);
    expect(out).toContain('- "continue until actually done" (seen 150× · 44 sessions)');
    expect(out).toContain("- /ship — Push, open a PR, review it");
    expect(out).not.toContain("triage issues"); // scheduled loops are not nudges
    expect(out).toContain("## Rules"); // default rules preserved
  });

  it("replaces ONLY the mined region, preserving user edits outside it", () => {
    const existing = DEFAULT_PLAYBOOK.replace(
      "- Prefer standing down over guessing.",
      "- Prefer standing down over guessing.\n- MY CUSTOM RULE: never touch prod.",
    );
    const out = generatePlaybook([nudge], existing);
    expect(out).toContain("MY CUSTOM RULE: never touch prod.");
    expect(out).toContain('"continue until actually done"');
  });

  it("returns null when the user removed the markers", () => {
    expect(generatePlaybook([nudge], "# my own playbook, no markers")).toBeNull();
  });

  it("regeneration is idempotent (second run replaces the first mined region)", () => {
    const once = generatePlaybook([nudge])!;
    const twice = generatePlaybook([command], once)!;
    expect(twice).not.toContain("continue until actually done");
    expect(twice).toContain("- /ship — Push, open a PR, review it");
    expect(twice.match(new RegExp(MINED_START, "g"))).toHaveLength(1);
  });
});

describe("writePlaybook / loadPlaybook", () => {
  it("writes to ~/.config/gradient/gradient.md and loads it back", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const path = await writePlaybook([nudge], home);
    expect(path).toBe(playbookPath(home));
    expect(await loadPlaybook(home)).toContain("continue until actually done");
  });

  it("leaves a marker-less user file untouched and returns null", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    await mkdir(dirname(playbookPath(home)), { recursive: true });
    await writeFile(playbookPath(home), "all mine now");
    expect(await writePlaybook([nudge], home)).toBeNull();
    expect(await readFile(playbookPath(home), "utf8")).toBe("all mine now");
  });

  it("falls back to DEFAULT_PLAYBOOK when no file exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    expect(await loadPlaybook(home)).toBe(DEFAULT_PLAYBOOK);
  });

  it("leaves an unreadable playbook untouched and returns null (not just ENOENT)", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-home-"));
    const path = playbookPath(home);
    // A directory at the playbook path makes readFile fail with EISDIR, not
    // ENOENT — writePlaybook must not treat that as "first run".
    await mkdir(path, { recursive: true });
    expect(await writePlaybook([nudge], home)).toBeNull();
    // The directory must still be there — nothing was overwritten.
    expect((await stat(path)).isDirectory()).toBe(true);
  });
});

describe("playbookPath", () => {
  it("points at gradient.md under the config dir", () => {
    expect(playbookPath("/home/u")).toBe("/home/u/.config/gradient/gradient.md");
  });
});

describe("DEFAULT_PLAYBOOK", () => {
  it("is titled gradient.md and keeps the mined markers + Rules", () => {
    expect(DEFAULT_PLAYBOOK).toContain("# gradient.md");
    expect(DEFAULT_PLAYBOOK).toContain(MINED_START);
    expect(DEFAULT_PLAYBOOK).toContain("## Rules");
  });
});
