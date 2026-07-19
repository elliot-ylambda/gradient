# gradient v2 Phase B — Recall & Adoption Loop — Implementation Plan

**Status:** Complete. Unchecked boxes below preserve the original test-first
execution recipe.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `UserPromptSubmit` hook (`gradient recall`) that matches typed prompts against installed artifacts (gradient-generated **and** hand-written) and injects a one-line hint, plus adoption tracking in `gradient stats` (uses, last-used, retypes caught, unused-artifact nudges). Spec: `docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md` §4.

**Architecture:** `core/recall.ts` builds/loads a small index (`.gradient/recall.json`) of artifact triggers + body signatures, self-healing via directory-mtime freshness. `commands/recall.ts` is the fail-open hook target (gate chain like `respond`, but LLM-free) and the `on|off|status` manager. `core/usage.ts` counts `<command-name>` tags in transcripts; `stats` merges uses + `adoption.jsonl` retype events into per-artifact adoption rows.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

- **Depends on Phase A** (skill artifacts, `triggers`, `emitSkill` description format). Branch: `spec/v2-phase-b` off merged Phase A.
- **Fail-open hook (spec §4 B1):** `gradient recall` (hook mode) always exits 0, never writes stderr, prints nothing unless hinting. No LLM, no network, no spawn — ever.
- **Thresholds (pinned here, spec §11):** `RECALL_THRESHOLD = 0.55`, `NEAR_MISS_THRESHOLD = 0.4`, minimum prompt length **15** chars, prompts starting with `/` never hint.
- **Hook entry:** event `UserPromptSubmit`, command exactly `gradient recall`, `timeout: 5`.
- **Hook output shape (spec §11 open question — verify at build time):** `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}` on stdout. Check the current hooks doc (`https://code.claude.com/docs` → hooks reference) when executing Task B3; if `additionalContext` is not honored, fall back to printing the hint as plain stdout text (also injected as context for this event).
- **Adoption log:** `.gradient/adoption.jsonl`, append-only lines `{ts, artifact, similarity, hinted}` — no prompt text is ever logged (privacy).
- **Unused nudge:** 0 uses **and** 0 retypes for ≥ **30** days → `suggestRemoval`.
- Tests: vitest with injected deps, no network. Run from `cli/`: `npm test`, `npm run typecheck`.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/recall.ts` (create) | index build/load/save/freshness; `matchPrompt`; thresholds |
| `cli/src/commands/recall.ts` (create) | hook pipeline; `setRecall on/off`; `recallStatus`; adoption log append |
| `cli/src/core/usage.ts` (create) | `<command-name>` tag counting from turns |
| `cli/src/commands/stats.ts` (modify) | adoption rows merged into the report |
| `cli/src/commands/apply.ts`, `remove.ts`, `migrate.ts`, `scan.ts` (modify) | rebuild recall index after artifact changes |
| `cli/src/cli.ts` (modify) | `recall` dispatch (hook + manager), stats rendering, HELP |
| `README.md` (modify) | recall section |

---

### Task B1: Recall index — build, save/load, freshness

**Files:**
- Create: `cli/src/core/recall.ts`
- Test: `cli/src/core/recall.test.ts` (create)

**Interfaces:**
- Consumes: `normalize` (`core/cluster.ts`), `gradientDir` (`core/manifest.ts`).
- Produces (B2/B3 rely on these exact names):
  - `interface RecallEntry { name: string; kind: "skill" | "command"; invocation: string; triggers: string[]; signature: string; description: string }`
  - `interface RecallIndex { builtAt: string; entries: RecallEntry[] }`
  - `recallIndexPath(projectDir: string): string` → `<projectDir>/.gradient/recall.json`
  - `buildRecallIndex(projectDir: string, home?: string): Promise<RecallIndex>` — scans four roots: `<projectDir>/.claude/commands/*.md`, `<projectDir>/.claude/skills/*/SKILL.md`, `<home>/.claude/commands/*.md`, `<home>/.claude/skills/*/SKILL.md`. Missing roots are fine.
  - `saveRecallIndex(projectDir, index): Promise<void>` / `loadRecallIndex(projectDir): Promise<RecallIndex | null>` (corrupt/absent → null)
  - `recallIndexFresh(index: RecallIndex, projectDir: string, home?: string): Promise<boolean>` — false when any artifact root or relevant command/skill file has mtime newer than `builtAt`
  - `extractTriggers(description: string): string[]` — parses the Phase A `Use when the user says things like: "a", "b".` clause; no clause → `[]`

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/recall.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecallIndex, saveRecallIndex, loadRecallIndex, recallIndexFresh, extractTriggers } from "./recall.js";

let dir: string; let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-rec-"));
  home = await mkdtemp(join(tmpdir(), "grad-rec-home-"));
});

async function seed() {
  await mkdir(join(dir, ".claude", "skills", "lgtm"), { recursive: true });
  await writeFile(join(dir, ".claude", "skills", "lgtm", "SKILL.md"),
    `---\nname: "lgtm"\ndescription: "Approve the PR. Use when the user says things like: \\"lgtm\\", \\"looks good\\"."\n---\nApprove and merge.\n`);
  await mkdir(join(home, ".claude", "commands"), { recursive: true });
  await writeFile(join(home, ".claude", "commands", "prep.md"),
    `---\ndescription: "Prep the current branch's PR for shipping"\n---\nSync it with main, verify it's green, review it, and open the PR.\n`);
}

describe("buildRecallIndex", () => {
  it("indexes project skills and user-level commands with triggers and signatures", async () => {
    await seed();
    const idx = await buildRecallIndex(dir, home);
    const names = idx.entries.map(e => e.invocation).sort();
    expect(names).toEqual(["/lgtm", "/prep"]);
    const lgtm = idx.entries.find(e => e.name === "lgtm")!;
    expect(lgtm).toMatchObject({ kind: "skill", triggers: ["lgtm", "looks good"] });
    expect(lgtm.signature).toContain("approve and merge");
    const prep = idx.entries.find(e => e.name === "prep")!;
    expect(prep.kind).toBe("command");
    expect(prep.triggers).toEqual([]);
  });
  it("returns an empty index when no artifact dirs exist", async () => {
    const idx = await buildRecallIndex(dir, home);
    expect(idx.entries).toEqual([]);
  });
});

describe("save/load/freshness", () => {
  it("round-trips and reports stale after an artifact dir changes", async () => {
    await seed();
    const idx = await buildRecallIndex(dir, home);
    await saveRecallIndex(dir, idx);
    expect(await loadRecallIndex(dir)).toEqual(idx);
    expect(await recallIndexFresh(idx, dir, home)).toBe(true);
    const future = new Date(Date.parse(idx.builtAt) + 60_000);
    await utimes(join(dir, ".claude", "skills"), future, future);
    expect(await recallIndexFresh(idx, dir, home)).toBe(false);
  });
  it("loadRecallIndex returns null on corrupt json", async () => {
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "recall.json"), "{nope");
    expect(await loadRecallIndex(dir)).toBeNull();
  });
});

describe("extractTriggers", () => {
  it("parses the Phase A description clause", () => {
    expect(extractTriggers('T. Use when the user says things like: "a", "b c".')).toEqual(["a", "b c"]);
    expect(extractTriggers("No clause here")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/recall.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `cli/src/core/recall.ts`:

```ts
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { normalize } from "./cluster.js";
import { gradientDir } from "./manifest.js";

export interface RecallEntry {
  name: string;
  kind: "skill" | "command";
  invocation: string;      // "/name"
  triggers: string[];      // mined phrasings (gradient skills); [] for hand-written
  signature: string;       // normalized body head, ≤200 chars
  description: string;     // normalized frontmatter description
}
export interface RecallIndex { builtAt: string; entries: RecallEntry[] }

export const RECALL_THRESHOLD = 0.55;
export const NEAR_MISS_THRESHOLD = 0.4;

export function recallIndexPath(projectDir: string): string {
  return join(gradientDir(projectDir), "recall.json");
}

export function extractTriggers(description: string): string[] {
  const m = /use when the user says things like: (.+)$/i.exec(description.trim());
  if (!m) return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let q: RegExpExecArray | null;
  while ((q = re.exec(m[1])) !== null) out.push(q[1].replace(/\\"/g, '"'));
  return out;
}

function splitFrontmatter(raw: string): { description: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { description: "", body: raw };
  const line = m[1].split("\n").find(l => l.startsWith("description:"));
  let description = line ? line.slice("description:".length).trim() : "";
  if (description.startsWith('"')) { try { description = JSON.parse(description) as string; } catch { /* raw */ } }
  return { description, body: raw.slice(m[0].length) };
}

async function entryFrom(path: string, name: string, kind: "skill" | "command"): Promise<RecallEntry | null> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); } catch { return null; }
  const { description, body } = splitFrontmatter(raw);
  return {
    name, kind, invocation: `/${name}`,
    triggers: extractTriggers(description),
    signature: normalize(body).slice(0, 200),
    description: normalize(description),
  };
}

async function scanRoot(root: string, kind: "skill" | "command"): Promise<RecallEntry[]> {
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const out: RecallEntry[] = [];
  for (const n of names) {
    const e = kind === "skill"
      ? await entryFrom(join(root, n, "SKILL.md"), n, "skill")
      : n.endsWith(".md") ? await entryFrom(join(root, n), n.slice(0, -3), "command") : null;
    if (e) out.push(e);
  }
  return out;
}

function artifactRoots(projectDir: string, home?: string): Array<{ root: string; kind: "skill" | "command" }> {
  const h = home ?? homedir();
  return [
    { root: join(projectDir, ".claude", "skills"), kind: "skill" },
    { root: join(projectDir, ".claude", "commands"), kind: "command" },
    { root: join(h, ".claude", "skills"), kind: "skill" },
    { root: join(h, ".claude", "commands"), kind: "command" },
  ];
}

export async function buildRecallIndex(projectDir: string, home?: string): Promise<RecallIndex> {
  const entries: RecallEntry[] = [];
  for (const { root, kind } of artifactRoots(projectDir, home)) entries.push(...(await scanRoot(root, kind)));
  return { builtAt: new Date().toISOString(), entries };
}

export async function saveRecallIndex(projectDir: string, index: RecallIndex): Promise<void> {
  const p = recallIndexPath(projectDir);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(index));
}

export async function loadRecallIndex(projectDir: string): Promise<RecallIndex | null> {
  try {
    const idx = JSON.parse(await readFile(recallIndexPath(projectDir), "utf8")) as RecallIndex;
    return Array.isArray(idx.entries) && typeof idx.builtAt === "string" ? idx : null;
  } catch { return null; }
}

export async function recallIndexFresh(index: RecallIndex, projectDir: string, home?: string): Promise<boolean> {
  const built = Date.parse(index.builtAt);
  for (const { root } of artifactRoots(projectDir, home)) {
    try { if ((await stat(root)).mtimeMs > built) return false; } catch { /* missing root is fine */ }
  }
  return true;
}
```

(Execution strengthened the planned root-only check: direct edits to an
existing `SKILL.md` or command file do not reliably bump the root directory,
so freshness also checks the relevant artifact file mtimes. See execution
notes.)

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/recall.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/recall.ts cli/src/core/recall.test.ts
git commit -m "feat(core): recall index — artifact triggers/signatures with mtime freshness"
```

---

### Task B2: Prompt matcher

**Files:**
- Modify: `cli/src/core/recall.ts`
- Test: `cli/src/core/recall.test.ts` (append)

**Interfaces:**
- Consumes: `similarity`, `normalize` (`core/cluster.ts`).
- Produces: `matchPrompt(prompt: string, index: RecallIndex): { entry: RecallEntry; score: number } | null` — score = max trigram similarity across each entry's `triggers`, `signature`, `description`; returns the best entry with its score (even below threshold — the caller applies `RECALL_THRESHOLD` / `NEAR_MISS_THRESHOLD`); null when the index is empty.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/recall.test.ts`:

```ts
import { matchPrompt, RECALL_THRESHOLD } from "./recall.js";

const entry = (over: Partial<RecallEntry>): RecallEntry => ({
  name: "x", kind: "skill", invocation: "/x", triggers: [], signature: "", description: "", ...over,
});

describe("matchPrompt", () => {
  it("matches a retyped trigger phrase near-exactly", () => {
    const idx = { builtAt: "t", entries: [entry({ name: "lgtm", triggers: ["lgtm", "looks good"] })] };
    const m = matchPrompt("Looks good!", idx);
    expect(m?.entry.name).toBe("lgtm");
    expect(m!.score).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
  });
  it("matches a retyped prompt against the artifact body signature", () => {
    const body = "push and create a pull request and then review it";
    const idx = { builtAt: "t", entries: [entry({ name: "ship", signature: body })] };
    const m = matchPrompt("push and create a pull request and then review it.", idx);
    expect(m?.entry.name).toBe("ship");
    expect(m!.score).toBeGreaterThanOrEqual(RECALL_THRESHOLD);
  });
  it("returns the best entry with a low score for unrelated prompts (caller thresholds)", () => {
    const idx = { builtAt: "t", entries: [entry({ name: "ship", signature: "push and open a pr" })] };
    const m = matchPrompt("explain the auth middleware to me", idx);
    expect(m!.score).toBeLessThan(RECALL_THRESHOLD);
  });
  it("returns null on an empty index", () => {
    expect(matchPrompt("anything", { builtAt: "t", entries: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/recall.test.ts`
Expected: FAIL — `matchPrompt` not exported.

- [ ] **Step 3: Implement** — append to `cli/src/core/recall.ts` (add `similarity` to the cluster import):

```ts
import { normalize, similarity } from "./cluster.js";

export function matchPrompt(prompt: string, index: RecallIndex): { entry: RecallEntry; score: number } | null {
  const p = normalize(prompt);
  let best: { entry: RecallEntry; score: number } | null = null;
  for (const entry of index.entries) {
    const targets = [...entry.triggers.map(normalize), entry.signature, entry.description].filter(t => t.length > 0);
    let score = 0;
    for (const t of targets) score = Math.max(score, similarity(p, t));
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/recall.test.ts`
Expected: PASS. If the trigger test's score lands under 0.55 (trigram sensitivity), the fix is to normalize both sides before comparing — already done — not to lower the threshold.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/recall.ts cli/src/core/recall.test.ts
git commit -m "feat(core): recall prompt matcher over triggers/signature/description"
```

---

### Task B3: `gradient recall` hook pipeline + adoption log + CLI

**Files:**
- Create: `cli/src/commands/recall.ts`
- Test: `cli/src/commands/recall.test.ts` (create)
- Modify: `cli/src/cli.ts`

**Interfaces:**
- Consumes: everything from B1/B2; `installHook`, `removeHook`, `hookInstalled` (`core/settings.ts`).
- Produces:
  - `interface RecallHookInput { prompt?: string; cwd?: string; session_id?: string }`
  - `recallHook(input: RecallHookInput, deps?: { home?: string; now?: () => string }): Promise<{ context?: string }>` — gates: missing/short (<15) prompt, `/`-prefixed prompt → `{}`; loads index (rebuild inline when missing or stale); match ≥ `RECALL_THRESHOLD` → context string `` The user's prompt closely matches their installed ${kind} "${invocation}" (mined from their own history). Prefer following that ${kind}'s workflow. `` and appends `{ts, artifact, similarity, hinted: true}` to `.gradient/adoption.jsonl`; `NEAR_MISS_THRESHOLD ≤ score < RECALL_THRESHOLD` → `{}` but logs `hinted: false`. **Never throws.**
  - `setRecall(on: boolean, projectDir: string, home?: string): Promise<{ installed: boolean; settingsPath: string }>` — on: `installHook(projectDir, "UserPromptSubmit", "gradient recall", { timeout: 5 })` + build & save index; off: `removeHook`.
  - `recallStatus(projectDir: string): Promise<{ installed: boolean; entries: number; builtAt?: string }>`
  - `appendAdoption(projectDir: string, e: { ts: string; artifact: string; similarity: number; hinted: boolean }): Promise<void>` (exported for stats tests)
  - CLI: `gradient recall` (no positional) = hook mode reading stdin, printing the `hookSpecificOutput` JSON only when hinting, always returning 0; `gradient recall on|off|status` = manager. HELP line added.

- [ ] **Step 1: Write the failing tests** — create `cli/src/commands/recall.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recallHook, setRecall, recallStatus } from "./recall.js";
import { saveRecallIndex } from "../core/recall.js";

let dir: string; let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-rc-"));
  home = await mkdtemp(join(tmpdir(), "grad-rc-h-"));
});

const IDX = { builtAt: new Date(Date.now() + 3_600_000).toISOString(), // future → always fresh in tests
  entries: [{ name: "ship", kind: "skill" as const, invocation: "/ship", triggers: ["push and create a pull request and then review it"], signature: "", description: "" }] };

describe("recallHook", () => {
  it("hints on a matching prompt and logs the adoption event", async () => {
    await saveRecallIndex(dir, IDX);
    const r = await recallHook({ prompt: "push and create a pull request and then review it.", cwd: dir }, { home });
    expect(r.context).toContain('"/ship"');
    const log = await readFile(join(dir, ".gradient", "adoption.jsonl"), "utf8");
    expect(JSON.parse(log.trim())).toMatchObject({ artifact: "ship", hinted: true });
  });
  it("stays silent on short, slash, and unmatched prompts", async () => {
    await saveRecallIndex(dir, IDX);
    expect(await recallHook({ prompt: "continue", cwd: dir }, { home })).toEqual({});
    expect(await recallHook({ prompt: "/ship the thing now please", cwd: dir }, { home })).toEqual({});
    expect(await recallHook({ prompt: "explain the auth middleware design to me", cwd: dir }, { home })).toEqual({});
  });
  it("builds the index inline when missing (no crash, may hint)", async () => {
    await mkdir(join(dir, ".claude", "skills", "ship"), { recursive: true });
    await writeFile(join(dir, ".claude", "skills", "ship", "SKILL.md"),
      `---\nname: "ship"\ndescription: "Ship it. Use when the user says things like: \\"push and create a pull request and then review it\\"."\n---\nbody\n`);
    const r = await recallHook({ prompt: "push and create a pull request and then review it", cwd: dir }, { home });
    expect(r.context).toContain('"/ship"');
  });
  it("never throws on garbage input", async () => {
    await expect(recallHook({}, { home })).resolves.toEqual({});
    await expect(recallHook({ prompt: "x".repeat(20), cwd: "/nonexistent/nope" }, { home })).resolves.toEqual({});
  });
});

describe("setRecall / recallStatus", () => {
  it("installs the UserPromptSubmit hook with timeout 5 and builds the index", async () => {
    const r = await setRecall(true, dir, home);
    expect(r.installed).toBe(true);
    const settings = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0]).toEqual({ type: "command", command: "gradient recall", timeout: 5 });
    expect((await recallStatus(dir)).installed).toBe(true);
  });
  it("off removes the hook", async () => {
    await setRecall(true, dir, home);
    await setRecall(false, dir, home);
    expect((await recallStatus(dir)).installed).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/recall.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `cli/src/commands/recall.ts`:

```ts
import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  loadRecallIndex, buildRecallIndex, saveRecallIndex, recallIndexFresh, matchPrompt,
  recallIndexPath, RECALL_THRESHOLD, NEAR_MISS_THRESHOLD, type RecallIndex,
} from "../core/recall.js";
import { installHook, removeHook, hookInstalled } from "../core/settings.js";
import { gradientDir } from "../core/manifest.js";

export interface RecallHookInput { prompt?: string; cwd?: string; session_id?: string }

export async function appendAdoption(
  projectDir: string,
  e: { ts: string; artifact: string; similarity: number; hinted: boolean },
): Promise<void> {
  const p = join(gradientDir(projectDir), "adoption.jsonl");
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, JSON.stringify(e) + "\n");
}

/** Fail-open, LLM-free. Every failure path resolves to {} (no hint). */
export async function recallHook(
  input: RecallHookInput,
  deps: { home?: string; now?: () => string } = {},
): Promise<{ context?: string }> {
  try {
    const prompt = (input.prompt ?? "").trim();
    if (prompt.length < 15 || prompt.startsWith("/")) return {};
    const projectDir = input.cwd ?? process.cwd();

    let index: RecallIndex | null = await loadRecallIndex(projectDir);
    if (!index || !(await recallIndexFresh(index, projectDir, deps.home))) {
      index = await buildRecallIndex(projectDir, deps.home);
      await saveRecallIndex(projectDir, index).catch(() => { /* read-only fs — still hint */ });
    }

    const m = matchPrompt(prompt, index);
    if (!m || m.score < NEAR_MISS_THRESHOLD) return {};
    const ts = (deps.now ?? (() => new Date().toISOString()))();
    const hinted = m.score >= RECALL_THRESHOLD;
    await appendAdoption(projectDir, { ts, artifact: m.entry.name, similarity: Number(m.score.toFixed(3)), hinted })
      .catch(() => { /* logging must never block the hint */ });
    if (!hinted) return {};
    return {
      context: `The user's prompt closely matches their installed ${m.entry.kind} "${m.entry.invocation}" (mined from their own history). Prefer following that ${m.entry.kind}'s workflow.`,
    };
  } catch {
    return {}; // fail-open
  }
}

export async function setRecall(
  on: boolean, projectDir: string, home?: string,
): Promise<{ installed: boolean; settingsPath: string }> {
  if (on) {
    const settingsPath = await installHook(projectDir, "UserPromptSubmit", "gradient recall", { timeout: 5 });
    await saveRecallIndex(projectDir, await buildRecallIndex(projectDir, home));
    return { installed: true, settingsPath };
  }
  const settingsPath = await removeHook(projectDir, "UserPromptSubmit", "gradient recall");
  return { installed: false, settingsPath };
}

export async function recallStatus(projectDir: string): Promise<{ installed: boolean; entries: number; builtAt?: string }> {
  const installed = await hookInstalled(projectDir, "UserPromptSubmit", "gradient recall");
  const index = await loadRecallIndex(projectDir);
  return { installed, entries: index?.entries.length ?? 0, builtAt: index?.builtAt };
}
```

`cli/src/cli.ts` — add the case (hook mode mirrors `respond`'s exit-0 contract) and a HELP line `gradient recall <on|off|status>  hint when a typed prompt matches an artifact`:

```ts
case "recall": {
  const arg = positionals[0];
  if (arg === "on" || arg === "off") {
    const r = await setRecall(arg === "on", projectDir);
    log(r.installed ? `${c.ok("recall hook installed")} ${c.muted(r.settingsPath)}` : `${c.muted("recall hook removed:")} ${r.settingsPath}`);
    return 0;
  }
  if (arg === "status") {
    const s = await recallStatus(projectDir);
    log(`${c.muted("recall:")} ${s.installed ? c.ok("on") : "off"}  ${c.dim(`index: ${s.entries} artifacts${s.builtAt ? ` (built ${s.builtAt})` : ""}`)}`);
    return 0;
  }
  // Hook mode. Contract: exit 0 ALWAYS; stdout only when hinting.
  try {
    const input = await readStdin();
    const r = await recallHook(input as RecallHookInput);
    if (r.context) {
      log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: r.context } }));
    }
  } catch { /* fail-open */ }
  return 0;
}
```

**Doc check (Global Constraints):** before finishing this task, verify the `UserPromptSubmit` output contract in the current hooks reference; if `additionalContext` is unsupported, print `r.context` bare instead. Record which form shipped in the commit message.

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/recall.ts cli/src/commands/recall.test.ts cli/src/cli.ts
git commit -m "feat(cli): gradient recall — UserPromptSubmit hint hook + adoption log"
```

---

### Task B4: Index rebuild on artifact changes

**Files:**
- Modify: `cli/src/commands/apply.ts`, `cli/src/commands/review.ts`, `cli/src/commands/remove.ts`, `cli/src/commands/migrate.ts`, `cli/src/commands/scan.ts`
- Test: `cli/src/commands/recall.test.ts` (append)

**Interfaces:**
- Consumes: `buildRecallIndex`, `saveRecallIndex`.
- Produces: after `applyByIds`, `review`, `remove` (successful), `migrate` (non-dry-run), and `scan`, the recall index on disk reflects the current artifacts. All rebuilds are best-effort (`.catch(() => {})`) — artifact operations never fail because of the index.

- [ ] **Step 1: Write the failing test** — append to `cli/src/commands/recall.test.ts`:

```ts
import { applyByIds } from "./apply.js";
import { remove } from "./remove.js";
import { loadRecallIndex as loadIdx } from "../core/recall.js";

it("apply and remove keep the recall index in sync", async () => {
  await mkdir(join(dir, ".gradient"), { recursive: true });
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([{
    id: "s1", name: "ship", title: "Ship it", rationale: "", confidence: "high",
    evidence: { count: 3, sessions: 2 },
    payload: { type: "command", commandName: "ship", body: "push and open a pr", triggers: ["ship it"] },
  }]));
  await applyByIds(["s1"], dir);
  expect((await loadIdx(dir))!.entries.some(e => e.name === "ship")).toBe(true);
  await remove(dir, "ship");
  expect((await loadIdx(dir))!.entries.some(e => e.name === "ship")).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/recall.test.ts`
Expected: FAIL — index missing or stale entry survives remove.

- [ ] **Step 3: Implement** — add to each command, after its artifact mutation succeeds (identical three lines; a shared helper is overkill for a fire-and-forget call, but if you prefer, export `refreshRecallIndex(projectDir)` from `commands/recall.ts` and call it in all five sites — do that, it keeps the `.catch` policy in one place):

In `cli/src/commands/recall.ts`:

```ts
export async function refreshRecallIndex(projectDir: string, home?: string): Promise<void> {
  try { await saveRecallIndex(projectDir, await buildRecallIndex(projectDir, home)); } catch { /* best-effort */ }
}
```

Call `await refreshRecallIndex(projectDir)`:
- `commands/apply.ts` — end of `applyByIds` (when `out.length > 0`)
- `commands/review.ts` — end of `review` (when `out.length > 0`)
- `commands/remove.ts` — end of `remove` before `return true`
- `commands/migrate.ts` — end of `migrate` (when `!opts.dryRun && migrated.length > 0`)
- `commands/scan.ts` — after the playbook write block

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/recall.ts cli/src/commands/apply.ts cli/src/commands/review.ts cli/src/commands/remove.ts cli/src/commands/migrate.ts cli/src/commands/scan.ts cli/src/commands/recall.test.ts
git commit -m "feat(recall): index stays in sync with apply/review/remove/migrate/scan"
```

---

### Task B5: Usage counting + adoption rows in stats

**Files:**
- Create: `cli/src/core/usage.ts`
- Modify: `cli/src/commands/stats.ts`, `cli/src/cli.ts`
- Test: `cli/src/core/usage.test.ts` (create), `cli/src/commands/stats.test.ts` (append)
- Modify: `README.md` (recall + adoption section)

**Interfaces:**
- Consumes: `Turn` (unfiltered — command tags are injected text, so usage counting runs **before** `filterPrompts`), `loadManifest`, `collect`, `parseFile`, `appendAdoption` log format.
- Produces:
  - `usage.ts`: `countArtifactUses(turns: Turn[], since: Map<string, string>): Map<string, { uses: number; lastUsed?: string }>` — `since` maps artifact name → `createdAt` ISO date; counts `<command-name>/name</command-name>` (slash optional) occurrences in user turns with `ts >= since`.
  - `stats.ts`: `StatsReport` gains `adoption: AdoptionRow[]` where `interface AdoptionRow { name: string; type: ArtifactType; createdAt: string; uses: number; lastUsed?: string; retypesCaught: number; suggestRemoval: boolean }`; `stats(projectDir, opts?: { home?: string; now?: number })` gains injected deps `{ collectFn?, parseFn? }` for tests (same pattern as `scan`).
  - `suggestRemoval` = `uses === 0 && retypesCaught === 0 && now - Date.parse(createdAt) >= 30 * 86_400_000`.
  - CLI stats rendering shows adoption columns and a removal hint line.

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/usage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { countArtifactUses } from "./usage.js";
import type { Turn } from "./types.js";

const t = (ts: string, text: string): Turn => ({ ts, project: "p", role: "user", sessionId: "s", text });

describe("countArtifactUses", () => {
  it("counts tag invocations since createdAt and tracks lastUsed", () => {
    const turns = [
      t("2026-07-01T00:00:00Z", "<command-name>/ship</command-name> args"),
      t("2026-07-02T00:00:00Z", "<command-name>ship</command-name>"),        // no leading slash
      t("2026-06-01T00:00:00Z", "<command-name>/ship</command-name>"),        // before createdAt
      t("2026-07-03T00:00:00Z", "plain prompt"),
    ];
    const uses = countArtifactUses(turns, new Map([["ship", "2026-06-15"]]));
    expect(uses.get("ship")).toEqual({ uses: 2, lastUsed: "2026-07-02T00:00:00Z" });
  });
  it("ignores names not in the manifest map", () => {
    const uses = countArtifactUses([t("2026-07-01T00:00:00Z", "<command-name>/other</command-name>")], new Map([["ship", "2026-01-01"]]));
    expect(uses.get("ship")).toEqual({ uses: 0, lastUsed: undefined });
  });
});
```

Append to `cli/src/commands/stats.test.ts` (reuse its temp-dir + suggestions/manifest seeding helpers):

```ts
it("reports adoption rows with retypes and a removal suggestion for stale artifacts", async () => {
  await addEntry(dir, { name: "ship", type: "skill", path: "p", createdAt: "2026-05-01", suggestionId: "s1" });
  await appendAdoption(dir, { ts: "2026-07-01T00:00:00Z", artifact: "ship", similarity: 0.8, hinted: true });
  const r = await stats(dir, { now: Date.parse("2026-07-06") , collectFn: async () => [], parseFn: async () => [] });
  const row = r.adoption.find(a => a.name === "ship")!;
  expect(row).toMatchObject({ uses: 0, retypesCaught: 1, suggestRemoval: false }); // retype activity → keep
});

it("suggests removal after 30 unused days with no retypes", async () => {
  await addEntry(dir, { name: "dead", type: "skill", path: "p", createdAt: "2026-05-01", suggestionId: "s2" });
  const r = await stats(dir, { now: Date.parse("2026-07-06"), collectFn: async () => [], parseFn: async () => [] });
  expect(r.adoption.find(a => a.name === "dead")!.suggestRemoval).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/usage.test.ts src/commands/stats.test.ts`
Expected: FAIL — modules/fields missing.

- [ ] **Step 3: Implement**

Create `cli/src/core/usage.ts`:

```ts
import type { Turn } from "./types.js";

const TAG_RE = /<command-name>\/?([\w:-]+)<\/command-name>/g;

/** Counts artifact invocations from raw (unfiltered) user turns. `since` maps
 * artifact name → createdAt; uses before creation don't count (spec §4 B2). */
export function countArtifactUses(
  turns: Turn[],
  since: Map<string, string>,
): Map<string, { uses: number; lastUsed?: string }> {
  const out = new Map<string, { uses: number; lastUsed?: string }>();
  for (const name of since.keys()) out.set(name, { uses: 0, lastUsed: undefined });
  for (const t of turns) {
    if (t.role !== "user" || !t.text) continue;
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(t.text)) !== null) {
      const rec = out.get(m[1]);
      if (!rec) continue;
      if (t.ts < (since.get(m[1]) ?? "")) continue;
      rec.uses++;
      if (!rec.lastUsed || t.ts > rec.lastUsed) rec.lastUsed = t.ts;
    }
  }
  return out;
}
```

In `cli/src/commands/stats.ts`: add the adoption assembly (new imports: `collect` from `../core/collect.js`, `parseFile` from `../core/parse.js`, `countArtifactUses` from `../core/usage.js`, `gradientDir` from `../core/manifest.js`, `readFile` from `node:fs/promises`, `join` from `node:path`, `ArtifactType` type):

```ts
export interface AdoptionRow {
  name: string; type: ArtifactType; createdAt: string;
  uses: number; lastUsed?: string; retypesCaught: number; suggestRemoval: boolean;
}
export const UNUSED_REMOVAL_DAYS = 30;

async function readRetypes(projectDir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const raw = await readFile(join(gradientDir(projectDir), "adoption.jsonl"), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { artifact?: string; hinted?: boolean };
        if (e.artifact && e.hinted) out.set(e.artifact, (out.get(e.artifact) ?? 0) + 1);
      } catch { /* skip bad line */ }
    }
  } catch { /* no log yet */ }
  return out;
}
```

Extend `stats(projectDir, opts)` — `opts` gains `{ now?: number; collectFn?: typeof collect; parseFn?: typeof parseFile }`:

```ts
const now = opts.now ?? Date.now();
const collectFn = opts.collectFn ?? collect;
const parseFn = opts.parseFn ?? parseFile;
const files = await collectFn({ scope: "project", projectPath: projectDir, home: opts.home });
const turns: Turn[] = [];
for (const f of files) turns.push(...(await parseFn(f)));
const since = new Map(manifest.map(m => [m.name, m.createdAt]));
const uses = countArtifactUses(turns, since);
const retypes = await readRetypes(projectDir);
const adoption: AdoptionRow[] = manifest.map(m => {
  const u = uses.get(m.name) ?? { uses: 0, lastUsed: undefined };
  const r = retypes.get(m.name) ?? 0;
  const ageMs = now - Date.parse(m.createdAt);
  return {
    name: m.name, type: m.type, createdAt: m.createdAt,
    uses: u.uses, lastUsed: u.lastUsed, retypesCaught: r,
    suggestRemoval: u.uses === 0 && r === 0 && ageMs >= UNUSED_REMOVAL_DAYS * 86_400_000,
  };
});
// add `adoption` to the returned StatsReport
```

`cli/src/cli.ts` stats case — after the existing pattern lines, render adoption (this extends the old coverage-only rendering per spec §10):

```ts
if (r.adoption.length > 0) {
  log(c.dim("\nadoption:"));
  for (const a of r.adoption) {
    const last = a.lastUsed ? a.lastUsed.slice(0, 10) : "never";
    log(`  ${c.bold(a.name)}  ${c.dim(`${a.uses} use(s) · last ${last} · ${a.retypesCaught} retype(s) caught`)}${a.suggestRemoval ? c.coral("  → unused 30d+, consider: gradient remove " + a.name) : ""}`);
  }
}
```

`README.md`: add a "Recall & adoption" subsection under the autopilot section — install (`gradient recall on`), what the hint looks like, what `.gradient/adoption.jsonl` stores (name + score only, no prompt text), and the `stats` adoption columns.

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/usage.ts cli/src/core/usage.test.ts cli/src/commands/stats.ts cli/src/commands/stats.test.ts cli/src/cli.ts README.md
git commit -m "feat(stats): adoption rows — uses, retypes caught, unused-artifact removal nudges"
```

---

## Execution notes (2026-07-09)

- **B1 freshness:** root directory mtimes catch additions/removals but not
  reliable in-place edits. The shipped check also walks relevant command and
  `SKILL.md` mtimes, preserving the spec's hand-edit self-healing guarantee.
- **B1 timestamp precision:** filesystem mtimes may include fractional
  milliseconds while ISO `builtAt` does not; comparisons use their shared
  millisecond precision to avoid an immediately-stale new index.
- **B3 hook schema:** verified against the current official Claude Code hooks
  reference. The shipped output is structured
  `hookSpecificOutput.additionalContext`, not plain stdout.
- **B3 idempotent install:** re-running `recall on` upgrades an existing hook
  entry to the required five-second timeout instead of merely detecting it.
- **B3 latency:** the published `gradient` bin now has a lightweight exact
  `recall` dispatcher instead of eagerly loading the full CLI/LLM graph. With
  24 real user artifacts, end-to-end subprocess latency measured 29.16 ms p50
  and 30.08 ms p95 (30 runs), below the 50 ms target.
- **B4 test isolation:** apply/review/remove/migrate refreshes accept the
  existing optional test `home`, so index tests never scan the developer's
  real user-level artifacts.
- **B5 live fixture:** local transcripts confirm installed skills including
  `/codex` and `/plan-review` use the same `<command-name>` representation as
  custom commands. Retype counts include only actual hints, not near misses,
  and exclude events predating the current manifest entry.
