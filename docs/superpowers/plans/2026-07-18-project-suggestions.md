# Project Suggestions → Committed gradient.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mine repo-local patterns into `project-playbook` suggestions, write approved ones into the committed `<repo>/gradient.md` with per-entry provenance tags, and make that file's prose judge-visible only under a local exact-bytes hash pin.

**Architecture:** New suggestion payload (`project-playbook`) flows through the existing scan → review → apply pipeline. A splice module edits the committed file line-surgically; a pin module in `core/playbook.ts` stores sha-256 consent in the per-project cache; `respond` feeds pinned prose to the judge; `review` presents unpinned/changed prose for approval. Spec: `docs/superpowers/specs/2026-07-18-project-suggestions-design.md`.

**Tech Stack:** TypeScript ESM, Node 20, vitest. Tests live beside sources (`foo.ts` / `foo.test.ts`).

## Global Constraints

- Exactly **one runtime dependency** (`@anthropic-ai/sdk`) — add nothing.
- All file I/O through `safeReadFile`/`safeWriteFile` from `core/safeFs.ts`.
- All content written to disk or into prompts passes `redact()` (`core/security.ts`).
- Payload text: single line, ≤500 chars, `stripUnsafeControls`-clean, no `<!--`/`-->`.
- Failure directions: pin errors fail **closed** (prose excluded); judge errors keep failing **open**; nothing ever escalates authority.
- Vocabulary: code symbols keep the "playbook" noun; user-facing strings say `gradient.md`.
- Committed-file writes use mode `0o644` (team file); private cache writes use `0o600`.
- Run tests from `cli/`: `(cd cli && npx vitest run <path>)`. Full suite: `(cd cli && npx vitest run)`.
- Working branch: `worktree-project-suggestions` in `.claude/worktrees/project-suggestions`. All paths below are relative to the worktree root.

---

### Task 1: Payload type and validation

**Files:**
- Modify: `cli/src/core/types.ts:3` (ArtifactType), `cli/src/core/types.ts:48-52` (SuggestionPayload)
- Modify: `cli/src/core/validate.ts:6` (TYPES), new arm after the `rule` arm (~line 92)
- Test: `cli/src/core/validate.test.ts`

**Interfaces:**
- Consumes: existing `validText`/`validOneLine` helpers in validate.ts.
- Produces: payload variant `{ type: "project-playbook"; section: "rules" | "workflows"; text: string }`; `ArtifactType` value `"playbook-entry"`. Later tasks rely on these exact strings.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/core/validate.test.ts`:

```ts
describe("project-playbook payload", () => {
  const pb = (payload: Record<string, unknown>) => ({
    ...good,
    payload: { type: "project-playbook", section: "workflows", text: "After tests pass, run make build.", ...payload },
  });

  it("accepts a valid workflows entry", () => {
    expect(() => validateSuggestion(pb({}))).not.toThrow();
  });

  it("accepts a valid rules entry", () => {
    expect(() => validateSuggestion(pb({ section: "rules", text: "Never deploy from autopilot here." }))).not.toThrow();
  });

  it("rejects unknown sections, multi-line, oversized, and comment-marker text", () => {
    expect(() => validateSuggestion(pb({ section: "notes" }))).toThrow(/section/);
    expect(() => validateSuggestion(pb({ text: "a\nb" }))).toThrow(/one-line/);
    expect(() => validateSuggestion(pb({ text: "x".repeat(501) }))).toThrow(/one-line/);
    expect(() => validateSuggestion(pb({ text: "sneaky <!-- gradient:x -->" }))).toThrow(/comment/);
    expect(() => validateSuggestion(pb({ text: "  " }))).toThrow(/one-line/);
  });
});
```

(`good` is the existing valid-suggestion fixture already used throughout the file; reuse it as-is.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd cli && npx vitest run src/core/validate.test.ts)`
Expected: FAIL with `invalid payload.type: project-playbook`

- [ ] **Step 3: Implement**

`cli/src/core/types.ts` — change line 3 and extend the payload union:

```ts
export type ArtifactType = "command" | "loop" | "hook" | "skill" | "rule" | "playbook-entry";
```

```ts
export type SuggestionPayload =
  | { type: "command"; commandName: string; body: string; triggers?: string[]; mechanical?: boolean }
  | { type: "loop"; instruction: string; cadence?: string }
  | { type: "hook"; event: string; subcommand: string; description: string; matcher?: string }
  | { type: "rule"; target: "project" | "user"; ruleName: string; text: string }
  | { type: "project-playbook"; section: "rules" | "workflows"; text: string };
```

`cli/src/core/validate.ts` — line 6:

```ts
const TYPES = new Set(["command", "loop", "hook", "rule", "project-playbook"]);
```

After the `rule` arm (after line 92):

```ts
  if (payload.type === "project-playbook") {
    if (payload.section !== "rules" && payload.section !== "workflows") {
      throw new Error("project-playbook payload section must be rules|workflows");
    }
    if (!validOneLine(payload.text, 500)) {
      throw new Error("project-playbook payload needs safe bounded one-line text");
    }
    if ((payload.text as string).includes("<!--") || (payload.text as string).includes("-->")) {
      throw new Error("project-playbook text must not contain comment markers");
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd cli && npx vitest run src/core/validate.test.ts)`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/types.ts cli/src/core/validate.ts cli/src/core/validate.test.ts
git commit -m "feat(types): project-playbook payload and playbook-entry artifact type"
```

---

### Task 2: Pin primitives in core/playbook.ts

**Files:**
- Modify: `cli/src/core/playbook.ts` (append after `loadProjectPlaybook`, ~line 209; add imports)
- Test: `cli/src/core/playbook.test.ts`

**Interfaces:**
- Consumes: `projectCacheDir(projectDir, home)` from `../config.js`; `safeReadFile`/`safeWriteFile`; existing `ProjectPlaybook`.
- Produces (later tasks call these exact signatures):
  - `interface PlaybookPin { hash: string; prose: string; pinnedAt: string }`
  - `type PinState = "pinned" | "changed" | "unpinned" | "none"`
  - `playbookPinPath(projectDir: string, home?: string): string`
  - `proseHash(prose: string): string`
  - `loadPlaybookPin(projectDir: string, home?: string): Promise<PlaybookPin | null>`
  - `savePlaybookPin(projectDir: string, prose: string, home?: string, now?: () => string): Promise<void>`
  - `pinState(project: ProjectPlaybook | null, pin: PlaybookPin | null): PinState`
  - `pinnedProse(project: ProjectPlaybook | null, pin: PlaybookPin | null): string`

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/core/playbook.test.ts` (merge the import lines below with the file's existing imports — no duplicate import statements):

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  loadPlaybookPin, savePlaybookPin, pinState, pinnedProse, proseHash, parseProjectPlaybook,
} from "./playbook.js";
import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

describe("playbook pin", () => {
  const tmp = () => mkdtemp(join(tmpdir(), "grad-pin-"));

  it("round-trips a pin and reports pinned", async () => {
    const home = await tmp(); const proj = await tmp();
    await savePlaybookPin(proj, "## Rules\n- be careful\n", home, () => "2026-07-18T00:00:00Z");
    const pin = await loadPlaybookPin(proj, home);
    expect(pin?.hash).toBe(proseHash("## Rules\n- be careful\n"));
    const project = parseProjectPlaybook("## Rules\n- be careful\n");
    expect(pinState(project, pin)).toBe("pinned");
    expect(pinnedProse(project, pin)).toBe("## Rules\n- be careful\n");
  });

  it("hash mismatch reports changed and yields no prose", async () => {
    const home = await tmp(); const proj = await tmp();
    await savePlaybookPin(proj, "old prose", home);
    const pin = await loadPlaybookPin(proj, home);
    const project = parseProjectPlaybook("edited prose");
    expect(pinState(project, pin)).toBe("changed");
    expect(pinnedProse(project, pin)).toBe("");
  });

  it("no pin file → unpinned; no project file → none", async () => {
    const home = await tmp(); const proj = await tmp();
    expect(pinState(parseProjectPlaybook("x"), await loadPlaybookPin(proj, home))).toBe("unpinned");
    expect(pinState(null, null)).toBe("none");
    expect(pinnedProse(null, null)).toBe("");
  });

  it("corrupt or internally inconsistent pin file → null (unpinned, fail closed)", async () => {
    const home = await tmp(); const proj = await tmp();
    await savePlaybookPin(proj, "prose", home);
    const pinFile = (await import("./playbook.js")).playbookPinPath(proj, home);
    await mkdir(dirname(pinFile), { recursive: true });
    await writeFile(pinFile, JSON.stringify({ hash: "a".repeat(64), prose: "prose", pinnedAt: "t" }));
    expect(await loadPlaybookPin(proj, home)).toBeNull();
    await writeFile(pinFile, "not json");
    expect(await loadPlaybookPin(proj, home)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd cli && npx vitest run src/core/playbook.test.ts)`
Expected: FAIL with missing exports (`savePlaybookPin` etc.)

- [ ] **Step 3: Implement**

In `cli/src/core/playbook.ts`, add to imports:

```ts
import { createHash } from "node:crypto";
import { projectCacheDir } from "../config.js";
```

Append at end of file:

```ts
/** Local exact-bytes consent for the committed gradient.md's prose. Stored in
 * the per-project cache, never in the repo: consent is per-user. */
export interface PlaybookPin {
  hash: string;     // sha-256 of the pinned prose
  prose: string;    // the pinned prose itself, kept for review diffs
  pinnedAt: string;
}

export type PinState = "pinned" | "changed" | "unpinned" | "none";

const PIN_FILE_MAX_BYTES = 300_000;

export function playbookPinPath(projectDir: string, home?: string): string {
  return join(projectCacheDir(projectDir, home), "playbook-pin.json");
}

export function proseHash(prose: string): string {
  return createHash("sha256").update(prose, "utf8").digest("hex");
}

/** Missing, unreadable, corrupt, or internally inconsistent pin → null.
 * Consent is never assumed. */
export async function loadPlaybookPin(projectDir: string, home?: string): Promise<PlaybookPin | null> {
  const userHome = home ?? homedir();
  try {
    const parsed = JSON.parse(await safeReadFile(
      userHome,
      playbookPinPath(projectDir, userHome),
      { maxBytes: PIN_FILE_MAX_BYTES },
    )) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" ||
      typeof parsed.hash !== "string" || !/^[a-f0-9]{64}$/.test(parsed.hash) ||
      typeof parsed.prose !== "string" || proseHash(parsed.prose) !== parsed.hash ||
      typeof parsed.pinnedAt !== "string") {
      return null;
    }
    return parsed as unknown as PlaybookPin;
  } catch {
    return null;
  }
}

export async function savePlaybookPin(
  projectDir: string,
  prose: string,
  home?: string,
  now?: () => string,
): Promise<void> {
  const userHome = home ?? homedir();
  const pin: PlaybookPin = {
    hash: proseHash(prose),
    prose,
    pinnedAt: (now ?? (() => new Date().toISOString()))(),
  };
  await safeWriteFile(userHome, playbookPinPath(projectDir, userHome), `${JSON.stringify(pin, null, 2)}\n`, { mode: 0o600 });
}

export function pinState(project: ProjectPlaybook | null, pin: PlaybookPin | null): PinState {
  if (project === null) return "none";
  if (pin === null) return "unpinned";
  return proseHash(project.prose) === pin.hash ? "pinned" : "changed";
}

/** The only prose the judge may see: exact-bytes consent or nothing. */
export function pinnedProse(project: ProjectPlaybook | null, pin: PlaybookPin | null): string {
  return pinState(project, pin) === "pinned" && project !== null ? project.prose : "";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd cli && npx vitest run src/core/playbook.test.ts)`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/playbook.ts cli/src/core/playbook.test.ts
git commit -m "feat(playbook): exact-bytes pin primitives for the committed gradient.md"
```

---

### Task 3: Splice module

**Files:**
- Create: `cli/src/core/playbook-splice.ts`
- Test: `cli/src/core/playbook-splice.test.ts`

**Interfaces:**
- Consumes: nothing project-specific (pure string functions).
- Produces (later tasks call these exact signatures):
  - `type PlaybookSection = "rules" | "workflows"`
  - `PROJECT_PLAYBOOK_TEMPLATE: string`
  - `entryTag(suggestionId: string): string` → `<!-- gradient:<id> -->`
  - `spliceLine(existing: string | null, section: PlaybookSection, line: string, suggestionId: string): string`
  - `removeTaggedLine(content: string, suggestionId: string): string | null`
  - `proseDiff(pinned: string, current: string): string`

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/playbook-splice.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  PROJECT_PLAYBOOK_TEMPLATE, entryTag, spliceLine, removeTaggedLine, proseDiff,
} from "./playbook-splice.js";

const LINE = `- After tests pass, run make build. ${entryTag("abc123")}`;

describe("spliceLine", () => {
  it("creates the template when the file is missing", () => {
    const out = spliceLine(null, "workflows", LINE, "abc123");
    expect(out).toContain("# gradient.md");
    expect(out).toContain(`## Workflows\n\n${LINE}`);
  });

  it("appends at the end of an existing section, before the next heading", () => {
    const existing = "---\nautopilot:\n  max-mode: nudge\n---\n## Rules\n- hand-written rule\n\n## Workflows\n- old entry\n";
    const out = spliceLine(existing, "rules", LINE, "abc123");
    const rulesBlock = out.slice(out.indexOf("## Rules"), out.indexOf("## Workflows"));
    expect(rulesBlock).toContain("- hand-written rule");
    expect(rulesBlock).toContain(LINE);
    expect(out.indexOf(LINE)).toBeLessThan(out.indexOf("## Workflows"));
  });

  it("never touches untagged lines or frontmatter", () => {
    const existing = "---\nautopilot:\n  budget: 3\n---\n## Rules\n- keep me\n";
    const out = spliceLine(existing, "rules", LINE, "abc123");
    expect(out).toContain("---\nautopilot:\n  budget: 3\n---");
    expect(out).toContain("- keep me");
  });

  it("appends a missing section", () => {
    const out = spliceLine("# hand-made\n\n## Rules\n- r\n", "workflows", LINE, "abc123");
    expect(out).toContain(`## Workflows\n\n${LINE}`);
    expect(out).toContain("- r");
  });

  it("is idempotent when the tag is already present", () => {
    const once = spliceLine(null, "rules", LINE, "abc123");
    expect(spliceLine(once, "rules", LINE, "abc123")).toBe(once);
  });
});

describe("removeTaggedLine", () => {
  it("removes exactly the tagged line", () => {
    const content = spliceLine("## Rules\n- keep me\n", "rules", LINE, "abc123");
    const out = removeTaggedLine(content, "abc123");
    expect(out).not.toContain(LINE);
    expect(out).toContain("- keep me");
  });

  it("returns null when the tag is absent", () => {
    expect(removeTaggedLine("## Rules\n- keep me\n", "abc123")).toBeNull();
  });
});

describe("proseDiff", () => {
  it("marks removed and added lines", () => {
    const diff = proseDiff("## Rules\n- old line\n- shared\n", "## Rules\n- new line\n- shared\n");
    expect(diff).toContain("- - old line");
    expect(diff).toContain("+ - new line");
    expect(diff).not.toContain("shared");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd cli && npx vitest run src/core/playbook-splice.test.ts)`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `cli/src/core/playbook-splice.ts`:

```ts
/** Line-surgical edits for the committed <repo>/gradient.md. Appends never
 * rewrite existing lines; removal deletes exactly one tagged line. */

export type PlaybookSection = "rules" | "workflows";

const SECTION_HEADINGS: Record<PlaybookSection, string> = {
  rules: "## Rules",
  workflows: "## Workflows",
};

export const PROJECT_PLAYBOOK_TEMPLATE = `# gradient.md — repo automation contract

## Rules

## Workflows
`;

export function entryTag(suggestionId: string): string {
  return `<!-- gradient:${suggestionId} -->`;
}

export function spliceLine(
  existing: string | null,
  section: PlaybookSection,
  line: string,
  suggestionId: string,
): string {
  const base = existing ?? PROJECT_PLAYBOOK_TEMPLATE;
  if (base.includes(entryTag(suggestionId))) return base; // idempotent re-apply
  const heading = SECTION_HEADINGS[section];
  const lines = base.split("\n");
  const headingIndex = lines.findIndex(candidate => candidate.trim() === heading);
  if (headingIndex === -1) {
    const separator = base === "" || base.endsWith("\n") ? "" : "\n";
    return `${base}${separator}\n${heading}\n\n${line}\n`;
  }
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  }
  // Insert after the section's last non-blank line; an empty section gets one
  // blank line between heading and entry.
  let last = headingIndex;
  for (let i = headingIndex + 1; i < end; i++) {
    if (lines[i].trim() !== "") last = i;
  }
  if (last === headingIndex) lines.splice(headingIndex + 1, 0, "", line);
  else lines.splice(last + 1, 0, line);
  return lines.join("\n");
}

export function removeTaggedLine(content: string, suggestionId: string): string | null {
  const tag = entryTag(suggestionId);
  const lines = content.split("\n");
  const index = lines.findIndex(candidate => candidate.includes(tag));
  if (index === -1) return null;
  lines.splice(index, 1);
  return lines.join("\n");
}

/** Set-difference diff: enough to show what consent would cover, without an
 * LCS implementation. Blank lines are noise and skipped. */
export function proseDiff(pinned: string, current: string): string {
  const pinnedLines = pinned.split("\n");
  const currentSet = new Set(current.split("\n"));
  const pinnedSet = new Set(pinnedLines);
  const removed = pinnedLines.filter(l => !currentSet.has(l) && l.trim() !== "");
  const added = current.split("\n").filter(l => !pinnedSet.has(l) && l.trim() !== "");
  return [...removed.map(l => `- ${l}`), ...added.map(l => `+ ${l}`)].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd cli && npx vitest run src/core/playbook-splice.test.ts)`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/playbook-splice.ts cli/src/core/playbook-splice.test.ts
git commit -m "feat(playbook): line-surgical splice module for the committed gradient.md"
```

---

### Task 4: Emitter and dispatch

**Files:**
- Create: `cli/src/core/emit/project-playbook.ts`
- Modify: `cli/src/core/emit/index.ts` (EmitResult union ~line 16, switch ~line 31)
- Modify: `cli/src/commands/review.ts:54-65` (`renderedText` preview branch)
- Test: `cli/src/core/emit/project-playbook.test.ts`

**Interfaces:**
- Consumes: `entryTag`, `PlaybookSection` (Task 3); `redact` from `../security.js`.
- Produces: `emitProjectPlaybook(s: Suggestion): { section: PlaybookSection; line: string }`; `EmitResult` gains `{ kind: "playbook-line"; section: PlaybookSection; line: string }`.

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/emit/project-playbook.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emitProjectPlaybook } from "./project-playbook.js";
import { emit } from "./index.js";
import type { Suggestion } from "../types.js";

const suggestion: Suggestion = {
  id: "abc123", name: "pb-build-after-tests", title: "Build after tests",
  rationale: "seen often", evidence: { count: 4, sessions: 3 }, confidence: "high",
  payload: { type: "project-playbook", section: "workflows", text: "After tests pass, run make build." },
};

describe("emitProjectPlaybook", () => {
  it("emits a tagged single-line bullet", () => {
    const out = emitProjectPlaybook(suggestion);
    expect(out.section).toBe("workflows");
    expect(out.line).toBe("- After tests pass, run make build. <!-- gradient:abc123 -->");
  });

  it("redacts secrets in the text", () => {
    const leaky = { ...suggestion, payload: { ...suggestion.payload, text: "Use api_key=supersecret123 after tests." } } as Suggestion;
    expect(emitProjectPlaybook(leaky).line).toContain("[REDACTED]");
    expect(emitProjectPlaybook(leaky).line).not.toContain("supersecret123");
  });

  it("dispatches through emit() as playbook-line and rejects the codex target", () => {
    expect(emit(suggestion)).toEqual({ kind: "playbook-line", section: "workflows", line: "- After tests pass, run make build. <!-- gradient:abc123 -->" });
    expect(() => emit(suggestion, { assistant: "codex" })).toThrow(/codex/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd cli && npx vitest run src/core/emit/project-playbook.test.ts)`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `cli/src/core/emit/project-playbook.ts`:

```ts
import type { Suggestion } from "../types.js";
import { redact } from "../security.js";
import { entryTag, type PlaybookSection } from "../playbook-splice.js";

/** One tagged bullet for the committed gradient.md. The tag is how apply
 * stays idempotent and remove finds exactly its own line. */
export function emitProjectPlaybook(s: Suggestion): { section: PlaybookSection; line: string } {
  if (s.payload.type !== "project-playbook") throw new Error("emitProjectPlaybook needs a project-playbook payload");
  const text = redact(s.payload.text).replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
  return { section: s.payload.section, line: `- ${text} ${entryTag(s.id)}` };
}
```

`cli/src/core/emit/index.ts` — add the import, the union member, and the switch case:

```ts
import { emitProjectPlaybook } from "./project-playbook.js";
```

```ts
export type EmitResult =
  | { kind: "command"; path: string; content: string }
  | { kind: "skill"; path: string; content: string; assistant: Assistant }
  | { kind: "loop"; command: string }
  | { kind: "hook"; settingsPatch: string }
  | { kind: "rule"; path: string; content: string }
  | { kind: "rule-print"; text: string }
  | { kind: "playbook-line"; section: "rules" | "workflows"; line: string };
```

```ts
    case "project-playbook": return { kind: "playbook-line", ...emitProjectPlaybook(s) };
```

(The codex guard at the top of `emit()` already throws for any type other than `command`/`rule` — no change needed there.)

`cli/src/commands/review.ts` — in `renderedText`, extend the kind chain (~line 58-64) with a `playbook-line` branch so previews render:

```ts
  const body = rendered.kind === "command" || rendered.kind === "skill" || rendered.kind === "rule"
    ? `${rendered.path}\n${rendered.content}`
    : rendered.kind === "loop"
      ? rendered.command
      : rendered.kind === "rule-print"
        ? rendered.text
        : rendered.kind === "playbook-line"
          ? `gradient.md (committed) → ## ${rendered.section === "rules" ? "Rules" : "Workflows"}\n${rendered.line}`
          : `.claude/settings.local.json (merged on approve)\n${rendered.settingsPatch}`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd cli && npx vitest run src/core/emit/project-playbook.test.ts src/commands/review.test.ts)`
Expected: PASS (review tests confirm no regression in preview rendering)

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/emit/project-playbook.ts cli/src/core/emit/project-playbook.test.ts cli/src/core/emit/index.ts cli/src/commands/review.ts
git commit -m "feat(emit): playbook-line emitter for project-playbook suggestions"
```

---

### Task 5: Manifest and approvals support

**Files:**
- Modify: `cli/src/core/manifest.ts:8` (ARTIFACT_TYPES), `:35-47` (expectedRelativePath)
- Modify: `cli/src/core/approvals.ts:12` (ARTIFACT_TYPES)
- Test: `cli/src/core/manifest.test.ts`

**Interfaces:**
- Consumes: existing `validateEntry` machinery.
- Produces: manifest entries with `type: "playbook-entry"` validate iff path is exactly `<projectDir>/gradient.md` and target is claude-code; `expectedArtifactPath` returns that path.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/core/manifest.test.ts` (reuse its existing tmp-dir helper pattern):

```ts
describe("playbook-entry manifest entries", () => {
  it("accepts a playbook-entry pointing at the repo gradient.md", async () => {
    const dir = await tmpProject();
    await addEntry(dir, {
      name: "pb-build-after-tests", type: "playbook-entry", path: join(dir, "gradient.md"),
      createdAt: "2026-07-18", suggestionId: "abc123",
    });
    const entries = await loadManifest(dir);
    expect(entries[0].type).toBe("playbook-entry");
    expect(expectedArtifactPath(dir, entries[0])).toBe(join(dir, "gradient.md"));
  });

  it("rejects a playbook-entry with any other path", async () => {
    const dir = await tmpProject();
    await expect(addEntry(dir, {
      name: "pb-x", type: "playbook-entry", path: join(dir, ".claude", "rules", "x.md"),
      createdAt: "2026-07-18", suggestionId: "abc124",
    })).rejects.toThrow(/path does not match/);
  });

  it("rejects a codex-target playbook-entry", async () => {
    const dir = await tmpProject();
    await expect(addEntry(dir, {
      name: "pb-y", type: "playbook-entry", path: join(dir, "gradient.md"),
      createdAt: "2026-07-18", suggestionId: "abc125", target: "codex",
    })).rejects.toThrow(/codex/);
  });
});
```

(If the file has no `tmpProject` helper, define one at the top of the new describe: `const tmpProject = () => mkdtemp(join(tmpdir(), "grad-manifest-"));` with the matching `node:fs/promises` / `node:os` imports.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd cli && npx vitest run src/core/manifest.test.ts)`
Expected: FAIL with `invalid type`

- [ ] **Step 3: Implement**

`cli/src/core/manifest.ts` line 8:

```ts
const ARTIFACT_TYPES = new Set<ArtifactType>(["command", "loop", "hook", "skill", "rule", "playbook-entry"]);
```

In `expectedRelativePath` (line 35), the codex branch already returns `null` for everything but skills; add the claude-code case:

```ts
  switch (type) {
    case "skill": return `.claude/skills/${name}/SKILL.md`;
    case "command": return `.claude/commands/${name}.md`;
    case "rule": return `.claude/rules/gradient-${name}.md`;
    case "playbook-entry": return "gradient.md";
    case "loop":
    case "hook": return null;
  }
```

In `validateEntry`, extend the codex artifact-type restriction (line 69):

```ts
  if (entry.target === "codex" && entry.type !== "skill" && entry.type !== "rule") {
    throw new Error(`manifest entry ${index} has an unsupported codex artifact type`);
  }
```

(already rejects `playbook-entry` for codex — verify, no change needed if so).

`cli/src/core/approvals.ts` line 12:

```ts
const ARTIFACT_TYPES = new Set<ArtifactType>(["command", "loop", "hook", "skill", "rule", "playbook-entry"]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd cli && npx vitest run src/core/manifest.test.ts src/core/approvals.test.ts)`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/manifest.ts cli/src/core/approvals.ts cli/src/core/manifest.test.ts
git commit -m "feat(manifest): playbook-entry artifact type anchored to the repo gradient.md"
```

---

### Task 6: Apply write path

**Files:**
- Modify: `cli/src/core/apply.ts` (imports; new branch in the result-kind chain, between the file-artifact branch and the loop branch, ~line 110; re-pin after `addEntry`)
- Test: `cli/src/core/apply.test.ts`

**Interfaces:**
- Consumes: `spliceLine`, `parseProjectPlaybook`, `savePlaybookPin` (Tasks 2-3); `EmitResult` kind `playbook-line` (Task 4); manifest type (Task 5).
- Produces: `applySuggestion` handles project-playbook suggestions end-to-end: splice → ledger → manifest → pin, with the existing rollback restoring the file on manifest failure.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/core/apply.test.ts` (reuse its existing tmp-project/suggestion fixtures style):

```ts
describe("applySuggestion project-playbook", () => {
  const pbSuggestion = (id = "abc123"): Suggestion => ({
    id, name: "pb-build-after-tests", title: "Build after tests",
    rationale: "seen often", evidence: { count: 4, sessions: 3 }, confidence: "high",
    payload: { type: "project-playbook", section: "workflows", text: "After tests pass, run make build." },
  });

  it("creates gradient.md from the template and pins the prose", async () => {
    const proj = await mkdtemp(join(tmpdir(), "grad-apply-pb-"));
    const home = await mkdtemp(join(tmpdir(), "grad-apply-home-"));
    const result = await applySuggestion(pbSuggestion(), proj, { home });
    const written = await readFile(join(proj, "gradient.md"), "utf8");
    expect(written).toContain("- After tests pass, run make build. <!-- gradient:abc123 -->");
    expect(result.writes[0].path).toBe(join(proj, "gradient.md"));
    const pin = await loadPlaybookPin(proj, home);
    expect(pin).not.toBeNull();
    expect(pinState(parseProjectPlaybook(written), pin)).toBe("pinned");
  });

  it("appends into an existing hand-written file without touching other lines", async () => {
    const proj = await mkdtemp(join(tmpdir(), "grad-apply-pb2-"));
    const home = await mkdtemp(join(tmpdir(), "grad-apply-home2-"));
    await writeFile(join(proj, "gradient.md"), "---\nautopilot:\n  max-mode: nudge\n---\n## Rules\n- hand rule\n\n## Workflows\n");
    await applySuggestion(pbSuggestion(), proj, { home });
    const written = await readFile(join(proj, "gradient.md"), "utf8");
    expect(written).toContain("max-mode: nudge");
    expect(written).toContain("- hand rule");
    expect(written).toContain("<!-- gradient:abc123 -->");
  });

  it("re-apply is a no-op on the file", async () => {
    const proj = await mkdtemp(join(tmpdir(), "grad-apply-pb3-"));
    const home = await mkdtemp(join(tmpdir(), "grad-apply-home3-"));
    await applySuggestion(pbSuggestion(), proj, { home });
    const once = await readFile(join(proj, "gradient.md"), "utf8");
    await applySuggestion(pbSuggestion(), proj, { home });
    expect(await readFile(join(proj, "gradient.md"), "utf8")).toBe(once);
  });
});
```

Add the needed imports to the test file if absent: `loadPlaybookPin`, `pinState`, `parseProjectPlaybook` from `./playbook.js`; `readFile`, `writeFile`, `mkdtemp` from `node:fs/promises`; `tmpdir` from `node:os`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd cli && npx vitest run src/core/apply.test.ts)`
Expected: FAIL — apply throws or writes nothing for the unknown kind

- [ ] **Step 3: Implement**

`cli/src/core/apply.ts` — add imports:

```ts
import { spliceLine } from "./playbook-splice.js";
import { parseProjectPlaybook, savePlaybookPin } from "./playbook.js";
```

In the result-kind chain inside `applySuggestion` (after the `command|skill|rule` branch, before `result.kind === "loop"`), add:

```ts
      } else if (result.kind === "playbook-line") {
        // Deliberate carve-out: the ONLY write allowed outside .claude/.agents
        // is the repo's own committed gradient.md, by constructed path.
        const abs = join(projectDir, "gradient.md");
        let existingContent: string | null = null;
        try {
          existingContent = await safeReadFile(projectDir, abs, { maxBytes: 256_000 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const next = spliceLine(existingContent, result.section, result.line, suggestion.id);
        if (next !== existingContent) {
          await safeWriteFile(projectDir, abs, next, { mode: 0o644 });
        }
        created = existingContent === null;
        previousContent = existingContent ?? undefined;
        written = abs;
        approvalContent = result.line;
        type = "playbook-entry";
```

After the existing `addEntry` try/catch block (still inside the per-target `try`), add the re-pin — pin only after the manifest succeeded, so rollback never has a pin to undo:

```ts
      if (type === "playbook-entry" && written) {
        const current = await safeReadFile(projectDir, written, { maxBytes: 256_000 });
        await savePlaybookPin(projectDir, parseProjectPlaybook(current).prose, opts.home);
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd cli && npx vitest run src/core/apply.test.ts)`
Expected: PASS, including all pre-existing apply tests (rollback behavior untouched)

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/apply.ts cli/src/core/apply.test.ts
git commit -m "feat(apply): splice approved project-playbook entries into the committed gradient.md and pin"
```

---

### Task 7: Mining routing

**Files:**
- Create: `cli/src/core/project-suggest.ts`
- Modify: `cli/src/commands/scan.ts` (import; new block after the attention block, ~line 242)
- Test: `cli/src/core/project-suggest.test.ts`

**Interfaces:**
- Consumes: `ChainFinding` from `./sequence.js`; `Suggestion`, `Assistant` from `./types.js`; `sanitizeName` from `./security.js`; `isNudge` from `./playbook.js`.
- Produces: `mineProjectPlaybook(suggestions: Suggestion[], chains: ChainFinding[], assistantBySession: Map<string, Assistant>): Suggestion[]` — called from scan; also exports `chainWorkflowSuggestion`, `nudgeRuleSuggestion`, `isConstraintShaped`, `PROJECT_MIN_COUNT = 3`, `PROJECT_MIN_SESSIONS = 2`.

- [ ] **Step 1: Write the failing tests**

Create `cli/src/core/project-suggest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  chainWorkflowSuggestion, nudgeRuleSuggestion, isConstraintShaped, mineProjectPlaybook,
} from "./project-suggest.js";
import type { ChainFinding } from "./sequence.js";
import type { Suggestion } from "./types.js";
import { validateSuggestion } from "./validate.js";

const chain = (over: Partial<ChainFinding> = {}): ChainFinding => ({
  steps: ["run the tests", "run make build"], count: 4, sessions: 3,
  sessionIds: ["s1", "s2", "s3"], examples: [], ...over,
});

const assistants = new Map([["s1", "claude-code"], ["s2", "codex"], ["s3", "claude-code"]] as const);

describe("chainWorkflowSuggestion", () => {
  it("produces a valid workflows suggestion with pooled assistants", () => {
    const s = chainWorkflowSuggestion(chain(), assistants);
    expect(s).not.toBeNull();
    validateSuggestion(s!);
    expect(s!.payload).toMatchObject({ type: "project-playbook", section: "workflows" });
    expect((s!.payload as { text: string }).text).toContain('After "run the tests"');
    expect(s!.evidence.assistants).toEqual(["claude-code", "codex"]);
  });

  it("returns null below the evidence thresholds", () => {
    expect(chainWorkflowSuggestion(chain({ count: 2 }), assistants)).toBeNull();
    expect(chainWorkflowSuggestion(chain({ sessions: 1, sessionIds: ["s1"] }), assistants)).toBeNull();
  });
});

describe("nudgeRuleSuggestion", () => {
  const nudge = (instruction: string, over: Partial<Suggestion> = {}): Suggestion => ({
    id: "n1", name: "keep-going", title: "t", rationale: "r",
    evidence: { count: 5, sessions: 3 }, confidence: "high",
    payload: { type: "loop", instruction }, ...over,
  });

  it("routes constraint-shaped nudges to a rules suggestion", () => {
    const s = nudgeRuleSuggestion(nudge("Never push directly to main."));
    expect(s).not.toBeNull();
    validateSuggestion(s!);
    expect(s!.payload).toMatchObject({ type: "project-playbook", section: "rules" });
  });

  it("ignores non-constraint nudges, scheduled loops, and weak evidence", () => {
    expect(nudgeRuleSuggestion(nudge("keep going until done"))).toBeNull();
    expect(nudgeRuleSuggestion(nudge("Never push.", { payload: { type: "loop", instruction: "Never push.", cadence: "daily" } }))).toBeNull();
    expect(nudgeRuleSuggestion(nudge("Never push.", { evidence: { count: 2, sessions: 1 } }))).toBeNull();
  });
});

describe("isConstraintShaped", () => {
  it("matches prohibition/requirement openers only", () => {
    expect(isConstraintShaped("Never deploy on Fridays")).toBe(true);
    expect(isConstraintShaped("Always run lint first")).toBe(true);
    expect(isConstraintShaped("don't touch prod")).toBe(true);
    expect(isConstraintShaped("please continue")).toBe(false);
  });
});

describe("mineProjectPlaybook", () => {
  it("combines both sources and dedupes by id", () => {
    const nudgeSuggestion: Suggestion = {
      id: "n1", name: "no-push", title: "t", rationale: "r",
      evidence: { count: 5, sessions: 3 }, confidence: "high",
      payload: { type: "loop", instruction: "Never push directly to main." },
    };
    const out = mineProjectPlaybook([nudgeSuggestion], [chain(), chain()], assistants);
    expect(out).toHaveLength(2); // 1 rule + 1 workflow (duplicate chain deduped)
    out.forEach(validateSuggestion);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd cli && npx vitest run src/core/project-suggest.test.ts)`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

Create `cli/src/core/project-suggest.ts`:

```ts
import { createHash } from "node:crypto";
import type { Assistant, Suggestion } from "./types.js";
import type { ChainFinding } from "./sequence.js";
import { sanitizeName } from "./security.js";
import { isNudge } from "./playbook.js";

/** Evidence floor for suggesting anything into the committed file: strong,
 * repeated, multi-session repo-local habit — not a one-off. */
export const PROJECT_MIN_COUNT = 3;
export const PROJECT_MIN_SESSIONS = 2;

const CONSTRAINT_RE = /^(never|don't|do not|always|avoid|only|must|stop)\b/i;

export function isConstraintShaped(text: string): boolean {
  return CONSTRAINT_RE.test(text.trim());
}

function suggestionId(seed: string): string {
  return createHash("sha256").update(`project-playbook:${seed}`).digest("hex").slice(0, 12);
}

function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 480);
}

export function chainWorkflowSuggestion(
  chain: ChainFinding,
  assistantBySession: ReadonlyMap<string, Assistant>,
): Suggestion | null {
  if (chain.count < PROJECT_MIN_COUNT || chain.sessions < PROJECT_MIN_SESSIONS) return null;
  const [first, second, third] = chain.steps.map(step => oneLine(step).slice(0, 120));
  if (!first || !second) return null;
  const text = oneLine(
    `After "${first}", the typical next step is "${second}"${third ? ` then "${third}"` : ""}.`,
  );
  const pooled = [...new Set(chain.sessionIds.map(id => assistantBySession.get(id) ?? "claude-code"))];
  return {
    id: suggestionId(`workflow:${chain.steps.join("→")}`),
    name: sanitizeName(`pb-after-${first}`),
    title: `Repo workflow: ${first} → ${second}`.slice(0, 200),
    rationale:
      `This sequence recurs in this repo (${chain.count}× across ${chain.sessions} sessions); ` +
      "committing it lets every approving teammate's judge know the typical next step.",
    evidence: { count: chain.count, sessions: chain.sessions, assistants: pooled },
    confidence: "inferred",
    payload: { type: "project-playbook", section: "workflows", text },
  };
}

export function nudgeRuleSuggestion(s: Suggestion): Suggestion | null {
  if (!isNudge(s) || s.payload.type !== "loop") return null;
  if (s.evidence.count < PROJECT_MIN_COUNT || s.evidence.sessions < PROJECT_MIN_SESSIONS) return null;
  const text = oneLine(s.payload.instruction);
  if (!isConstraintShaped(text)) return null;
  return {
    id: suggestionId(`rule:${text}`),
    name: sanitizeName(`pb-rule-${text.slice(0, 24)}`),
    title: `Repo rule: ${text}`.slice(0, 200),
    rationale:
      `You repeat this constraint in this repo (${s.evidence.count}× across ${s.evidence.sessions} sessions); ` +
      "committing it lets every approving teammate's judge stand down accordingly.",
    evidence: s.evidence,
    confidence: "inferred",
    payload: { type: "project-playbook", section: "rules", text },
  };
}

/** Both sources, deduped by derived id. Pure — scan wires it in. */
export function mineProjectPlaybook(
  suggestions: Suggestion[],
  chains: ChainFinding[],
  assistantBySession: ReadonlyMap<string, Assistant>,
): Suggestion[] {
  const out = new Map<string, Suggestion>();
  for (const chain of chains) {
    const s = chainWorkflowSuggestion(chain, assistantBySession);
    if (s) out.set(s.id, s);
  }
  for (const s of suggestions) {
    const rule = nudgeRuleSuggestion(s);
    if (rule) out.set(rule.id, rule);
  }
  return [...out.values()];
}
```

`cli/src/commands/scan.ts` — add the import and, after the attention block (after line 242, before `saveSuggestions`), add:

```ts
import { mineProjectPlaybook } from "../core/project-suggest.js";
```

```ts
  try {
    if (opts.scope === "project") {
      const projectSuggestions = mineProjectPlaybook(valid, sequence.chains, assistantBySession);
      for (const suggestion of projectSuggestions) {
        validateSuggestion(suggestion);
        valid.push(suggestion);
      }
      if (projectSuggestions.length > 0) {
        log(`${projectSuggestions.length} suggestion(s) for the committed gradient.md`);
      }
    }
  } catch (error) {
    log(`project playbook mining failed: ${(error as Error).message}`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd cli && npx vitest run src/core/project-suggest.test.ts src/commands/scan.test.ts)`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/project-suggest.ts cli/src/core/project-suggest.test.ts cli/src/commands/scan.ts
git commit -m "feat(scan): route strong repo-local chains and constraint nudges to project-playbook suggestions"
```

---

### Task 8: Judge prompt and respond pin gate

**Files:**
- Modify: `cli/src/core/judge.ts:13-38` (`buildJudgePrompt`)
- Modify: `cli/src/commands/respond.ts` (import; pin load + prose in the judge call, ~line 115-129)
- Test: `cli/src/core/judge.test.ts` (rewrite two tests), `cli/src/commands/respond.test.ts` (rename one, add one)

**Interfaces:**
- Consumes: `loadPlaybookPin`, `pinnedProse` (Task 2).
- Produces: `buildJudgePrompt(mode, playbook, projectPlaybook, tail)` — non-empty `projectPlaybook` renders a `PROJECT PLAYBOOK (this repo):` block above `YOUR PLAYBOOK:`.

- [ ] **Step 1: Update/write the failing tests**

In `cli/src/core/judge.test.ts`, **replace** the test `"embeds only the trusted personal playbook and tail; nudge has no next-step authority"` and the test `"does not create a repository playbook section"` with:

```ts
  it("embeds the personal playbook and tail; nudge has no next-step authority", () => {
    const req = buildJudgePrompt("nudge", "PB-CONTENT", "", "TAIL-CONTENT");
    expect(req.prompt).toContain("PB-CONTENT");
    expect(req.prompt).toContain("TAIL-CONTENT");
    expect(req.prompt).not.toContain("PROJECT PLAYBOOK");
    expect(req.system).toContain("stand down");
    expect(req.system).not.toContain("typical next step");
  });

  it("renders a provenance-labeled project block only for pinned prose", () => {
    const req = buildJudgePrompt("nudge", "PB-CONTENT", "PROJ-CONTENT", "TAIL-CONTENT");
    expect(req.prompt).toContain("PROJECT PLAYBOOK (this repo):\nPROJ-CONTENT");
    expect(req.prompt.indexOf("PROJECT PLAYBOOK")).toBeLessThan(req.prompt.indexOf("YOUR PLAYBOOK"));
    expect(buildJudgePrompt("nudge", "pb", "   ", "tail").prompt).not.toContain("PROJECT PLAYBOOK");
  });
```

In `cli/src/commands/respond.test.ts`, **rename** the test `"repository prose never reaches the judge prompt or emitted nudge"` to `"unpinned repository prose never reaches the judge prompt or emitted nudge"` (body unchanged — no pin exists in its fresh home), and add below it:

```ts
  it("pinned repository prose reaches the judge with its provenance label", async () => {
    const home = await tmpHome();
    const cwd = await repoWith("---\nautopilot:\n  max-mode: nudge\n---\n## Rules\n- SENTINEL-PROSE\n");
    const { parseProjectPlaybook, savePlaybookPin } = await import("../core/playbook.js");
    // Pin the exact prose the file will parse to (body after the frontmatter block).
    const prose = parseProjectPlaybook("---\nautopilot:\n  max-mode: nudge\n---\n## Rules\n- SENTINEL-PROSE\n").prose;
    await savePlaybookPin(cwd, prose, home);
    let seenPrompt = "";
    const backend: LLMBackend = { name: "f", available: async () => true, complete: async (req) => { seenPrompt = req.prompt; return CONTINUE; } };
    const r = await respond({ session_id: "s", transcript_path: "t", cwd },
      { home, config: consent(cwd), backend, readLines: async () => transcript(3), env: {}, now: () => "T" });
    expect(r.decision).toBe("block");
    expect(seenPrompt).toContain("PROJECT PLAYBOOK (this repo):");
    expect(seenPrompt).toContain("SENTINEL-PROSE");
    expect(r).toEqual({ decision: "block", reason: "Continue." });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd cli && npx vitest run src/core/judge.test.ts src/commands/respond.test.ts)`
Expected: FAIL — no `PROJECT PLAYBOOK` block is rendered

- [ ] **Step 3: Implement**

`cli/src/core/judge.ts` — rename the parameter and render the block:

```ts
export function buildJudgePrompt(
  mode: "nudge" | "full",
  playbook: string,
  projectPlaybook: string,
  tail: string,
): LLMRequest {
```

and replace the return with:

```ts
  // Pinned-prose consent only: respond passes "" unless the local user's pin
  // matches the committed file's exact prose bytes.
  const projectBlock = projectPlaybook.trim()
    ? `PROJECT PLAYBOOK (this repo):\n${projectPlaybook}\n\n`
    : "";
  return {
    system,
    prompt:
      projectBlock +
      `YOUR PLAYBOOK:\n${playbook}\n\n` +
      `TRANSCRIPT TAIL:\n${tail}`,
  };
```

`cli/src/commands/respond.ts` — extend the playbook import and pass the pinned prose:

```ts
import { loadPlaybook, loadProjectPlaybook, clampMode, loadPlaybookPin, pinnedProse } from "../core/playbook.js";
```

Just after `const playbook = ...` (line 119), add:

```ts
    // Pin check fails closed: any error below yields "" and the judge sees
    // only the personal playbook. Clamps above already applied regardless.
    const pin = await loadPlaybookPin(input.cwd, deps.home);
    const projectProse = redact(pinnedProse(project, pin)).slice(0, PLAYBOOK_CAP);
```

and change the judge call:

```ts
      buildJudgePrompt(effectiveMode, playbook, projectProse, tail),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd cli && npx vitest run src/core/judge.test.ts src/commands/respond.test.ts)`
Expected: PASS — including the unpinned sentinel test proving unconsented prose still never reaches the judge

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/judge.ts cli/src/core/judge.test.ts cli/src/commands/respond.ts cli/src/commands/respond.test.ts
git commit -m "feat(respond): pinned project prose reaches the judge under exact-bytes consent"
```

---

### Task 9: Review consent step

**Files:**
- Modify: `cli/src/commands/review.ts` (imports; `PlaybookPrompter` type; pin step at the top of `review()`; `readlinePlaybookPrompter`; `reviewJson` shape)
- Modify: `cli/src/cli.ts:131-134` (pass the prompter), plus the `review --json` call site (`grep -n "reviewJson" cli/src/cli.ts`)
- Test: `cli/src/commands/review.test.ts`

**Interfaces:**
- Consumes: `loadProjectPlaybook`, `loadPlaybookPin`, `savePlaybookPin`, `pinState` (Task 2); `proseDiff` (Task 3).
- Produces: `type PlaybookPrompter = (diff: string, state: "unpinned" | "changed") => Promise<"approve" | "skip">`; `review(projectDir, prompt, opts)` gains `opts.playbookPrompter?: PlaybookPrompter`; `reviewJson` returns `{ projectPlaybook: PinState, suggestions: Suggestion[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/commands/review.test.ts` (reuse its tmp/home fixtures):

```ts
describe("review project playbook pinning", () => {
  it("presents an unpinned playbook and pins on approve", async () => {
    const home = await tmpHome();
    const proj = await mkdtemp(join(tmpdir(), "grad-review-pb-"));
    await writeFile(join(proj, "gradient.md"), "## Rules\n- team rule\n");
    let sawState = ""; let sawDiff = "";
    await review(proj, async () => "quit", {
      home,
      playbookPrompter: async (diff, state) => { sawState = state; sawDiff = diff; return "approve"; },
    });
    expect(sawState).toBe("unpinned");
    expect(sawDiff).toContain("+ - team rule");
    const { loadPlaybookPin, loadProjectPlaybook, pinState } = await import("../core/playbook.js");
    expect(pinState(await loadProjectPlaybook(proj), await loadPlaybookPin(proj, home))).toBe("pinned");
  });

  it("shows a diff for a changed playbook and leaves state untouched on skip", async () => {
    const home = await tmpHome();
    const proj = await mkdtemp(join(tmpdir(), "grad-review-pb2-"));
    const { savePlaybookPin } = await import("../core/playbook.js");
    await savePlaybookPin(proj, "## Rules\n- old rule\n", home);
    await writeFile(join(proj, "gradient.md"), "## Rules\n- new rule\n");
    let sawDiff = "";
    await review(proj, async () => "quit", {
      home,
      playbookPrompter: async (diff) => { sawDiff = diff; return "skip"; },
    });
    expect(sawDiff).toContain("- - old rule");
    expect(sawDiff).toContain("+ - new rule");
    const { loadPlaybookPin, loadProjectPlaybook, pinState } = await import("../core/playbook.js");
    expect(pinState(await loadProjectPlaybook(proj), await loadPlaybookPin(proj, home))).toBe("changed");
  });

  it("does not prompt when pinned or when no file exists", async () => {
    const home = await tmpHome();
    const proj = await mkdtemp(join(tmpdir(), "grad-review-pb3-"));
    let called = false;
    await review(proj, async () => "quit", { home, playbookPrompter: async () => { called = true; return "skip"; } });
    expect(called).toBe(false);
  });
});

describe("reviewJson project playbook state", () => {
  it("reports the pin state alongside suggestions", async () => {
    const home = await tmpHome();
    const proj = await mkdtemp(join(tmpdir(), "grad-review-pb4-"));
    await writeFile(join(proj, "gradient.md"), "## Rules\n- r\n");
    const parsed = JSON.parse(await reviewJson(proj, home));
    expect(parsed.projectPlaybook).toBe("unpinned");
    expect(Array.isArray(parsed.suggestions)).toBe(true);
  });
});
```

Add missing imports at the top of the test file if absent: `mkdtemp`, `writeFile` from `node:fs/promises`, `tmpdir` from `node:os`, `join` from `node:path`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd cli && npx vitest run src/commands/review.test.ts)`
Expected: FAIL — `playbookPrompter` unknown / `reviewJson` returns an array

- [ ] **Step 3: Implement**

`cli/src/commands/review.ts` — imports:

```ts
import { isNudge, loadProjectPlaybook, loadPlaybookPin, savePlaybookPin, pinState, type PinState } from "../core/playbook.js";
import { proseDiff } from "../core/playbook-splice.js";
```

Add the type next to `Prompter`:

```ts
/** Consent prompt for the committed gradient.md's prose. Approve pins the
 * exact bytes; the judge sees nothing until then. */
export type PlaybookPrompter = (diff: string, state: "unpinned" | "changed") => Promise<"approve" | "skip">;
```

At the top of `review()` (before the suggestions loop), add:

```ts
  const project = await loadProjectPlaybook(projectDir);
  if (project && opts.playbookPrompter) {
    const pin = await loadPlaybookPin(projectDir, opts.home);
    const state = pinState(project, pin);
    if (state === "unpinned" || state === "changed") {
      const diff = state === "unpinned"
        ? project.prose.split("\n").filter(l => l.trim() !== "").map(l => `+ ${l}`).join("\n")
        : proseDiff(pin!.prose, project.prose);
      if (await opts.playbookPrompter(stripUnsafeControls(diff), state) === "approve") {
        await savePlaybookPin(projectDir, project.prose, opts.home);
      }
    }
  }
```

and extend the `opts` type of `review`:

```ts
  opts: { home?: string; onSkip?: (message: string) => void; clarifier?: Clarifier; playbookPrompter?: PlaybookPrompter } = {},
```

Add the readline prompter next to `readlineClarifier`:

```ts
export function readlinePlaybookPrompter(): PlaybookPrompter {
  return async (diff, state) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(state === "unpinned"
      ? "\nThis repo's gradient.md is not yet approved as judge context for you:\n"
      : "\nThis repo's gradient.md changed since you approved it:\n");
    process.stdout.write(`${diff}\n`);
    const answer = (await rl.question("  approve it for your autopilot judge? [a]pprove [s]kip › ")).trim().toLowerCase();
    rl.close();
    return answer === "a" ? "approve" : "skip";
  };
}
```

Replace `reviewJson`:

```ts
/** Non-interactive listing for tooling (the plugin's review skill). */
export async function reviewJson(projectDir: string, home?: string): Promise<string> {
  let projectPlaybook: PinState = "none";
  try {
    projectPlaybook = pinState(await loadProjectPlaybook(projectDir), await loadPlaybookPin(projectDir, home));
  } catch { /* fail closed: reported as none */ }
  try {
    return JSON.stringify({ projectPlaybook, suggestions: await loadSuggestions(projectDir, { home }) }, null, 2);
  } catch {
    return JSON.stringify({ projectPlaybook, suggestions: [] }, null, 2);
  }
}
```

`cli/src/cli.ts` line 131-134 — leave the `readlinePrompter({...})` argument object exactly as it is; change only the trailing opts object of the `review(...)` call from

```ts
  }), { home, onSkip: log, clarifier: readlineClarifier() });
```

to

```ts
  }), { home, onSkip: log, clarifier: readlineClarifier(), playbookPrompter: readlinePlaybookPrompter() });
```

and add `readlinePlaybookPrompter` to the import from `./commands/review.js` (line 6). Then find every other consumer of the old array shape: run `grep -rn "reviewJson" cli/src plugin skills` and update each call site for the `{ projectPlaybook, suggestions }` object (the plugin's committed bundle is regenerated in Task 11 if the grep shows it embeds this output shape; update any skill markdown that documents the old shape).

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd cli && npx vitest run src/commands/review.test.ts)`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/review.ts cli/src/commands/review.test.ts cli/src/cli.ts
git commit -m "feat(review): present and pin the committed gradient.md's prose"
```

---

### Task 10: Status line and removal

**Files:**
- Modify: `cli/src/commands/autopilot.ts:55-115` (status interface + computation)
- Modify: `cli/src/cli.ts` (status render — locate with `grep -n "projectPlaybookExists\|effectiveMode" cli/src/cli.ts`)
- Modify: `cli/src/commands/remove.ts` (playbook-entry branch)
- Test: `cli/src/commands/autopilot.test.ts`, `cli/src/commands/remove.test.ts`

**Interfaces:**
- Consumes: `pinState`, `loadPlaybookPin`, `savePlaybookPin`, `parseProjectPlaybook` (Task 2); `entryTag`, `removeTaggedLine` (Task 3); manifest `expectedArtifactPath` (Task 5).
- Produces: `AutopilotStatus` gains `projectPlaybookPin: PinState`; `remove()` un-splices playbook entries instead of unlinking.

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/commands/autopilot.test.ts` (reuse its home/project fixtures):

```ts
  it("status reports the project playbook pin state", async () => {
    const home = await tmpHome();
    const proj = await mkdtemp(join(tmpdir(), "grad-ap-pin-"));
    expect((await autopilotStatus(proj, { home })).projectPlaybookPin).toBe("none");
    await writeFile(join(proj, "gradient.md"), "## Rules\n- r\n");
    expect((await autopilotStatus(proj, { home })).projectPlaybookPin).toBe("unpinned");
    const { savePlaybookPin, parseProjectPlaybook } = await import("../core/playbook.js");
    await savePlaybookPin(proj, parseProjectPlaybook("## Rules\n- r\n").prose, home);
    expect((await autopilotStatus(proj, { home })).projectPlaybookPin).toBe("pinned");
    await writeFile(join(proj, "gradient.md"), "## Rules\n- edited\n");
    expect((await autopilotStatus(proj, { home })).projectPlaybookPin).toBe("changed");
  });
```

Append to `cli/src/commands/remove.test.ts`:

```ts
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
```

Add any missing imports (`applySuggestion` from `../core/apply.js`, fs helpers) to the test files.

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd cli && npx vitest run src/commands/autopilot.test.ts src/commands/remove.test.ts)`
Expected: FAIL — `projectPlaybookPin` undefined; remove refuses/unlinks wrongly

- [ ] **Step 3: Implement**

`cli/src/commands/autopilot.ts` — import and interface:

```ts
import { playbookPath, projectPlaybookPath, loadProjectPlaybook, clampMode, loadPlaybookPin, pinState, type PinState } from "../core/playbook.js";
```

```ts
  projectPlaybookExists: boolean;
  projectPlaybookPin: PinState;
```

In `autopilotStatus`'s return object:

```ts
    projectPlaybookExists: project !== null,
    projectPlaybookPin: pinState(project, await loadPlaybookPin(projectDir, opts.home)),
```

`cli/src/cli.ts` — in the status render (next to the `projectPlaybookExists` line found by the grep), add:

```ts
  log(`project playbook: ${status.projectPlaybookExists ? status.projectPlaybookPin : "none"}`);
```

matching the surrounding output style (`log`/`process.stdout.write` — mirror the adjacent lines exactly).

`cli/src/commands/remove.ts` — imports:

```ts
import { entryTag, removeTaggedLine } from "../core/playbook-splice.js";
import { parseProjectPlaybook, savePlaybookPin } from "../core/playbook.js";
import { safeReadFile, safeUnlink, safeWriteFile, assertNoSymlinkPath } from "../core/safeFs.js";
```

Split entries at the top of `remove()` (after the manifest load):

```ts
  const playbookEntries = entries.filter(entry => entry.type === "playbook-entry");
  const fileEntries = entries.filter(entry => entry.type !== "playbook-entry");
```

Use `fileEntries` (not `entries`) in the existing validation and deletion loops. Add validation for playbook entries after the existing validation loop:

```ts
  for (const entry of playbookEntries) {
    const path = expectedArtifactPath(projectDir, entry);
    await assertNoSymlinkPath(projectDir, path, { includeTarget: false });
    try {
      const content = await safeReadFile(projectDir, path, { maxBytes: 256_000 });
      if (!content.includes(entryTag(entry.suggestionId))) {
        throw new Error(`refusing to remove playbook entry without its provenance tag: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
```

After the file-deletion loop (before the hook un-merge loop), add the un-splice:

```ts
  // Playbook entries live inside the committed gradient.md: delete exactly
  // the tagged line, never the file, and re-pin (removal is a local consent act).
  for (const entry of playbookEntries) {
    const path = expectedArtifactPath(projectDir, entry);
    try {
      const content = await safeReadFile(projectDir, path, { maxBytes: 256_000 });
      const next = removeTaggedLine(content, entry.suggestionId);
      if (next !== null) {
        await safeWriteFile(projectDir, path, next, { mode: 0o644 });
        await savePlaybookPin(projectDir, parseProjectPlaybook(next).prose, opts.home);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd cli && npx vitest run src/commands/autopilot.test.ts src/commands/remove.test.ts)`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/autopilot.ts cli/src/cli.ts cli/src/commands/remove.ts cli/src/commands/autopilot.test.ts cli/src/commands/remove.test.ts
git commit -m "feat(status,remove): pin-state reporting and line-surgical playbook-entry removal"
```

---

### Task 11: Bundle label, docs, and full-suite verification

**Files:**
- Modify: `cli/src/core/bundle.ts:203` (skip playbook entries with an honest note)
- Modify: `README.md` (the clamps-only description)
- Modify: `docs/superpowers/specs/2026-07-01-gradient-md-design.md` (one sentence appended to the amendment note)
- Test: full suite

**Interfaces:** none new — cleanup and docs.

- [ ] **Step 1: Bundle skip**

In `cli/src/core/bundle.ts`, next to the existing `if (entry.type === "skill") continue;` (line 203), add:

```ts
    if (entry.type === "playbook-entry") continue; // already lives in the committed gradient.md
```

If bundle tests assert entry counts, update them accordingly.

- [ ] **Step 2: README**

Run `grep -n "never reaches the judge\|clamps" README.md`. Update the committed-gradient.md description to state: clamps always enforce; prose reaches your judge only after you approve it in `gradient review` (exact-bytes pin), and any unapproved edit silently un-pins it. Keep the surrounding copy style.

- [ ] **Step 3: Amend the prior spec's note**

In `docs/superpowers/specs/2026-07-01-gradient-md-design.md`, append one sentence to the end of the `> **Amended 2026-07-18:** …` blockquote:

```markdown
> Superseded in part by
> [`2026-07-18-project-suggestions-design.md`](./2026-07-18-project-suggestions-design.md):
> prose now reaches the judge when the local user has pinned those exact
> bytes via `gradient review`.
```

- [ ] **Step 4: Plugin/consumer sweep**

Run `grep -rn "reviewJson\|review --json" cli/src skills plugin 2>/dev/null`. Update any consumer or doc still assuming the old bare-array shape from Task 9. Also confirm `cli/src/commands/list.ts` needs no change (it has no per-type branches — verify with `grep -n "entry.type" cli/src/commands/list.ts`, expect no matches). If the committed plugin bundle embeds the CLI, rebuild it the way `chore(plugin): refresh bundled cli` (commit 031d889) did — check `git show 031d889 --stat` for the exact regeneration steps.

- [ ] **Step 5: Full suite + build**

Run: `(cd cli && npx vitest run)` — Expected: all tests pass.
Run: `make build` — Expected: clean compile.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/bundle.ts README.md docs/superpowers/specs/2026-07-01-gradient-md-design.md
git commit -m "docs(gradient.md): pinned-consent model in README, spec cross-amendment, bundle label"
```

---

## Post-plan checks

- Every failure direction verified: corrupt pin → unpinned; malformed frontmatter → clamps off; judge errors → fail open. No path adds authority.
- No dead code: `buildJudgePrompt`'s project parameter and `ProjectPlaybook.prose` now have live consumers; no shipped symbol becomes unused.
- Vocabulary check: `grep -rn "playbook-pin\|project playbook" cli/src` — user-facing strings say `gradient.md`, code keeps the playbook noun.
