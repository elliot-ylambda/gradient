# gradient — Review Disambiguation & Attention Hooks — Implementation Plan

**Status:** Complete. Unchecked boxes below preserve the original plan; the
security amendment documents the shipped behavior.

> **Security amendment (0.3.1):** The implementation deliberately supersedes
> the original code snippets below. The model supplies only a bounded/redacted
> question and 2–3 short labels; all option bodies are reconstructed locally
> with an authorization guard. Unresolved flagged suggestions are never
> approvable, the resolution is saved only in the private per-project user
> cache, attention reads are no-follow and resource-capped, hook tuples are
> allowlisted exactly, and notifications use absolute `/usr/bin` paths with
> static arguments. The task-by-task snippets remain as historical execution
> context and are not the normative security contract.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flagged suggestions carry a judge-authored clarifying question the user answers in `review` (Component 1); scans that find long waiting-on-you gaps suggest a `Notification` desktop-ping hook backed by a new fail-open `gradient notify` subcommand (Component 2). Spec: `docs/superpowers/specs/2026-07-09-gradient-review-clarify-design.md`.

**Architecture:** The detect LLM emits `clarify` labels at detect time; a `sanitizeClarify` gate reconstructs guarded option bodies locally. `review` resolves the choice offline, persists it to the private user cache, and requires a separate exact-artifact approval. `core/attention.ts` computes bounded question→answer gaps from no-follow transcript reads; `scan` appends one deterministic hook suggestion when the floor is crossed. `emitHook` validates the exact matcher/event/subcommand tuple; `notify` is a static, fail-open OS wrapper.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

- **Execute after Spec 4 Phase A merges** (A5 rewrites the detect prompt this plan extends; A4 touches `review.ts`).
- **Constants (spec §2, pinned here):** clarify options 2–3; `ATTENTION_MIN_GAP_MS = 300_000` (5 min), `ATTENTION_MIN_SESSIONS = 5`.
- Resolution promotes `confidence` to `"high"` and records `clarify.chosen`; the suggestion `id` never changes.
- `notify` never emits stdout and always exits 0 — missing binary, bad stdin, unknown platform are all silent no-ops. The notification text is static (`NOTIFY_BODY`); transcript content never reaches it.
- `KNOWN_SUBCOMMANDS` gains `"notify"`; hook `matcher` is emitted only when present.
- Tests: vitest, no network, no real `claude`, spawns mocked. Run from `cli/`: `npm test`, `npm run typecheck`.
- Branch: `spec/review-clarify`. Commit after every task.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/types.ts` (modify) | `Clarify`, `ClarifyOption`, `Suggestion.clarify?`, hook payload `matcher?` |
| `cli/src/core/detect.ts` (modify) | prompt asks for `clarify` on flagged; `sanitizeClarify` |
| `cli/src/core/validate.ts` (modify) | `matcher` string check; `KNOWN_SUBCOMMANDS` += `notify` |
| `cli/src/commands/review.ts` (modify) | `Clarifier`, `resolveClarify`, readline clarifier, persistence |
| `cli/src/commands/apply.ts` (modify) | `saveSuggestions` |
| `cli/src/core/attention.ts` (create) | gap extraction + stats + deterministic suggestion builder |
| `cli/src/core/emit/hook.ts` (modify) | `matcher` in the settings patch |
| `cli/src/commands/scan.ts` (modify) | attention wiring + log line |
| `cli/src/commands/notify.ts` (create) | OS notification, fail-open |
| `cli/src/cli.ts` (modify) | `notify` dispatch; `explain` renders clarify; HELP |

---

### Task R1: Clarify schema — types, detect prompt, `sanitizeClarify`

**Files:**
- Modify: `cli/src/core/types.ts`, `cli/src/core/detect.ts`
- Test: `cli/src/core/detect.test.ts` (append)

**Interfaces:**
- Consumes: existing `buildDetectPrompt`, detect's LLM-response mapping.
- Produces (later tasks rely on these exact names):
  - `types.ts`: `interface ClarifyOption { label: string; body: string }`; `interface Clarify { question: string; options: ClarifyOption[]; chosen?: string }`; `Suggestion.clarify?: Clarify`
  - `detect.ts`: `sanitizeClarify(x: unknown): Clarify | undefined` (exported); flagged suggestions from the LLM keep a valid `clarify`, malformed ones lose the field and survive otherwise untouched.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/detect.test.ts`:

```ts
import { sanitizeClarify } from "./detect.js";

describe("sanitizeClarify", () => {
  const good = { question: "Acknowledge or merge?", options: [
    { label: "acknowledge", body: "Treat as sign-off only." },
    { label: "merge", body: "Approve and merge once checks pass." },
  ] };
  it("passes a valid 2-option clarify through", () => {
    expect(sanitizeClarify(good)).toEqual(good);
  });
  it("accepts 3 options, rejects 1 and 4", () => {
    const opt = good.options[0];
    expect(sanitizeClarify({ ...good, options: [opt, opt, opt] })).toBeDefined();
    expect(sanitizeClarify({ ...good, options: [opt] })).toBeUndefined();
    expect(sanitizeClarify({ ...good, options: [opt, opt, opt, opt] })).toBeUndefined();
  });
  it("rejects non-string fields and missing pieces", () => {
    expect(sanitizeClarify(undefined)).toBeUndefined();
    expect(sanitizeClarify({ question: 1, options: good.options })).toBeUndefined();
    expect(sanitizeClarify({ question: "q", options: [{ label: "a", body: 2 }, good.options[0]] })).toBeUndefined();
    expect(sanitizeClarify({ question: "q" })).toBeUndefined();
  });
  it("strips unknown keys from options", () => {
    const noisy = { question: "q", options: [
      { label: "a", body: "b", extra: true }, { label: "c", body: "d" },
    ] };
    expect(sanitizeClarify(noisy)).toEqual({ question: "q", options: [
      { label: "a", body: "b" }, { label: "c", body: "d" },
    ] });
  });
});

it("asks for clarify on flagged suggestions in the system prompt", () => {
  const { system } = buildDetectPrompt([]);
  expect(system).toContain("clarify");
  expect(system).toMatch(/flagged/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/detect.test.ts`
Expected: FAIL — `sanitizeClarify` not exported; prompt lacks clarify wording.

- [ ] **Step 3: Implement**

`cli/src/core/types.ts`:

```ts
/** One reading of an ambiguous pattern; body is the complete payload body under that reading. */
export interface ClarifyOption { label: string; body: string }

/** Judge-authored disambiguation for flagged suggestions (Spec 9 §3).
 * `chosen` is set by review when the user resolves it. */
export interface Clarify { question: string; options: ClarifyOption[]; chosen?: string }
```

and on `Suggestion`:

```ts
  clarify?: Clarify;
```

`cli/src/core/detect.ts` — export the gate:

```ts
import type { Clarify } from "./types.js";

/** Tolerant reader for the LLM's clarify field: valid shape or nothing.
 * A malformed clarify never rejects the suggestion — it just drops (spec §2 D2). */
export function sanitizeClarify(x: unknown): Clarify | undefined {
  const c = x as { question?: unknown; options?: unknown } | undefined;
  if (!c || typeof c !== "object" || typeof c.question !== "string") return undefined;
  if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > 3) return undefined;
  const options = [];
  for (const o of c.options as { label?: unknown; body?: unknown }[]) {
    if (!o || typeof o.label !== "string" || typeof o.body !== "string") return undefined;
    options.push({ label: o.label, body: o.body });
  }
  return { question: c.question, options };
}
```

In `LlmSuggestion`, add `clarify?: unknown;`. In the response mapping (inside the `.map(s => {...})` return object), attach it for flagged suggestions only:

```ts
          confidence: ALLOWED_CONFIDENCE.has(s.confidence) ? s.confidence : "inferred",
          ...(s.confidence === "flagged" && sanitizeClarify(s.clarify)
            ? { clarify: sanitizeClarify(s.clarify) }
            : {}),
```

In `buildDetectPrompt`'s `system` string, append (leave existing sentences untouched):

```ts
"When you mark a suggestion 'flagged' because the user's intent is ambiguous, ALSO include " +
"clarify: {question, options:[{label, body}]} with 2-3 options — one short question, and per " +
"option a complete replacement payload body reflecting that reading. " +
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/types.ts cli/src/core/detect.ts cli/src/core/detect.test.ts
git commit -m "feat(detect): flagged suggestions carry a sanitized clarify question"
```

---

### Task R2: Review resolution — `Clarifier`, persistence, `explain` provenance

**Files:**
- Modify: `cli/src/commands/review.ts`, `cli/src/commands/apply.ts`, `cli/src/cli.ts`
- Test: `cli/src/commands/review.test.ts` (append)

**Interfaces:**
- Consumes: `Clarify` from R1, `loadSuggestions`, `gradientDir`.
- Produces:
  - `apply.ts`: `saveSuggestions(projectDir: string, s: Suggestion[]): Promise<void>`
  - `review.ts`: `type Clarifier = (s: Suggestion) => Promise<string | null>`; `resolveClarify(s: Suggestion, label: string): Suggestion | null`; `review(projectDir, prompt, clarifier?)`; `readlineClarifier(): Clarifier`
  - `cli.ts`: review passes `readlineClarifier()`; `explain` prints question/options/chosen.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/commands/review.test.ts` (self-contained temp dir; merge these imports with the file's existing ones):

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveClarify, review } from "./review.js";
import { loadSuggestions, saveSuggestions } from "./apply.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "grad-clarify-")); });

const flagged = {
  id: "c1", name: "lgtm", title: "LGTM approval", rationale: "",
  evidence: { count: 3, sessions: 2 }, confidence: "flagged" as const,
  payload: { type: "command" as const, commandName: "lgtm", body: "ambiguous" },
  clarify: { question: "Acknowledge or merge?", options: [
    { label: "acknowledge", body: "Treat as sign-off only." },
    { label: "merge", body: "Approve and merge once checks pass." },
  ] },
};

describe("resolveClarify", () => {
  it("swaps the body, promotes confidence, records chosen, keeps id", () => {
    const r = resolveClarify(flagged, "merge")!;
    expect(r.id).toBe("c1");
    expect(r.confidence).toBe("high");
    expect(r.payload).toMatchObject({ type: "command", body: "Approve and merge once checks pass." });
    expect(r.clarify?.chosen).toBe("merge");
  });
  it("returns null for unknown labels and non-command payloads", () => {
    expect(resolveClarify(flagged, "nope")).toBeNull();
    const loop = { ...flagged, payload: { type: "loop" as const, instruction: "x" } };
    expect(resolveClarify(loop, "merge")).toBeNull();
  });
});

describe("review with clarifier", () => {
  it("resolves, persists, then applies the chosen body", async () => {
    await saveSuggestions(dir, [flagged]);
    const applied = await review(dir, async () => "approve", async () => "merge");
    expect(applied).toHaveLength(1);
    expect(applied[0].suggestion.payload).toMatchObject({ body: "Approve and merge once checks pass." });
    const persisted = await loadSuggestions(dir);
    expect(persisted[0].clarify?.chosen).toBe("merge");
    expect(persisted[0].confidence).toBe("high");
  });
  it("declining the clarifier leaves the suggestion flagged and unresolved", async () => {
    await saveSuggestions(dir, [flagged]);
    await review(dir, async () => "skip", async () => null);
    const persisted = await loadSuggestions(dir);
    expect(persisted[0].confidence).toBe("flagged");
    expect(persisted[0].clarify?.chosen).toBeUndefined();
  });
  it("already-resolved suggestions skip the clarifier", async () => {
    await saveSuggestions(dir, [{ ...flagged, clarify: { ...flagged.clarify, chosen: "merge" } }]);
    let called = 0;
    await review(dir, async () => "skip", async () => { called++; return null; });
    expect(called).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/review.test.ts`
Expected: FAIL — `resolveClarify` / `saveSuggestions` not exported.

- [ ] **Step 3: Implement**

`cli/src/commands/apply.ts` (imports gain `writeFile`, `mkdir`):

```ts
export async function saveSuggestions(projectDir: string, s: Suggestion[]): Promise<void> {
  await mkdir(gradientDir(projectDir), { recursive: true });
  await writeFile(join(gradientDir(projectDir), "suggestions.json"), JSON.stringify(s, null, 2));
}
```

`cli/src/commands/review.ts`:

```ts
import { loadSuggestions, saveSuggestions } from "./apply.js";

/** Returns the chosen option label, or null to leave the suggestion unresolved. */
export type Clarifier = (s: Suggestion) => Promise<string | null>;

/** Pure resolution: body swap + promotion + provenance. Command payloads only (spec §3). */
export function resolveClarify(s: Suggestion, label: string): Suggestion | null {
  const opt = s.clarify?.options.find(o => o.label === label);
  if (!opt || s.payload.type !== "command") return null;
  return {
    ...s,
    confidence: "high",
    payload: { ...s.payload, body: opt.body },
    clarify: { ...s.clarify!, chosen: label },
  };
}

export async function review(projectDir: string, prompt: Prompter, clarifier?: Clarifier): Promise<ApplyResult[]> {
  const suggestions = await loadSuggestions(projectDir);
  const out: ApplyResult[] = [];
  let dirty = false;
  for (let i = 0; i < suggestions.length; i++) {
    let s = suggestions[i];
    if (clarifier && s.confidence === "flagged" && s.clarify && !s.clarify.chosen && s.payload.type === "command") {
      const label = await clarifier(s);
      const resolved = label === null ? null : resolveClarify(s, label);
      if (resolved) { suggestions[i] = s = resolved; dirty = true; }
    }
    const decision = await prompt(s, i, suggestions.length);
    if (decision === "quit") break;
    if (decision === "approve") out.push(await applySuggestion(s, projectDir));
  }
  if (dirty) await saveSuggestions(projectDir, suggestions);
  return out;
}
```

(Keep whatever `applySuggestion` options Phase A4 threads through here — e.g. `{ emitTarget }` — untouched; this task only changes *which suggestion object* is passed and adds the clarify block + persistence.)

```ts

export function readlineClarifier(): Clarifier {
  return async (s) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(`\n  ${s.clarify!.question}\n`);
    s.clarify!.options.forEach((o, i) => process.stdout.write(`    [${i + 1}] ${o.label} — ${o.body.slice(0, 80)}\n`));
    const ans = (await rl.question("  choose a number (enter to decide later) › ")).trim();
    rl.close();
    const idx = Number(ans) - 1;
    return s.clarify!.options[idx]?.label ?? null;
  };
}
```

`cli/src/cli.ts` — review case: `await review(projectDir, readlinePrompter(), readlineClarifier())`. Explain case, after the examples loop:

```ts
        if (s.clarify) {
          log(c.dim(`clarify: ${s.clarify.question}`));
          for (const o of s.clarify.options) {
            log(`  ${s.clarify.chosen === o.label ? c.ok("✓") : c.muted("·")} ${o.label} — ${c.dim(o.body.slice(0, 100))}`);
          }
        }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS — the review tests that don't pass a clarifier stay green (param optional).

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/review.ts cli/src/commands/review.test.ts cli/src/commands/apply.ts cli/src/cli.ts
git commit -m "feat(review): flagged suggestions resolve via one clarifying question"
```

---

### Task R3: `core/attention.ts` — waiting-on-you gaps + hook payload matcher

**Files:**
- Create: `cli/src/core/attention.ts`
- Modify: `cli/src/core/types.ts`, `cli/src/core/emit/hook.ts`, `cli/src/core/validate.ts`
- Test: `cli/src/core/attention.test.ts` (create), `cli/src/core/emit/emit.test.ts` (append)

**Interfaces:**
- Consumes: transcript JSONL lines (same raw shape `tail.ts` reads).
- Produces:
  - `attention.ts`: `ATTENTION_MIN_GAP_MS = 300_000`, `ATTENTION_MIN_SESSIONS = 5`; `interface AttentionStats { gaps: number; sessions: number; medianMinutes: number }`; `gapsInLines(lines: string[]): number[]` (ms deltas ≥ floor); `mineAttention(files: string[], readFn?: (p: string) => Promise<string>): Promise<AttentionStats | null>`; `attentionSuggestion(a: AttentionStats): Suggestion` (deterministic, id from sha1 of a fixed key)
  - `types.ts`: hook payload gains `matcher?: string`
  - `emit/hook.ts`: patch group includes `"matcher"` when present
  - `validate.ts`: `KNOWN_SUBCOMMANDS` += `"notify"`; `matcher`, when present, must be a string.

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/attention.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { gapsInLines, mineAttention, attentionSuggestion, ATTENTION_MIN_SESSIONS } from "./attention.js";

const asst = (ts: string, text: string) => JSON.stringify({
  type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] },
});
const user = (ts: string, text: string) => JSON.stringify({
  type: "user", timestamp: ts, message: { role: "user", content: text },
});

describe("gapsInLines", () => {
  it("finds a gap when an assistant question waits ≥5min for the answer", () => {
    const lines = [asst("2026-07-09T10:00:00Z", "Should I merge?"), user("2026-07-09T10:07:00Z", "yes")];
    expect(gapsInLines(lines)).toEqual([420_000]);
  });
  it("ignores fast answers and non-question assistant turns", () => {
    expect(gapsInLines([asst("2026-07-09T10:00:00Z", "Should I merge?"), user("2026-07-09T10:01:00Z", "yes")])).toEqual([]);
    expect(gapsInLines([asst("2026-07-09T10:00:00Z", "Done."), user("2026-07-09T10:20:00Z", "next")])).toEqual([]);
  });
  it("returns empty on malformed lines", () => {
    expect(gapsInLines(["not json", "{}"])).toEqual([]);
  });
});

describe("mineAttention", () => {
  const gapFile = [asst("2026-07-09T10:00:00Z", "Proceed?"), user("2026-07-09T10:10:00Z", "yes")].join("\n");
  it("aggregates across files and applies the session floor", async () => {
    const files = Array.from({ length: ATTENTION_MIN_SESSIONS }, (_, i) => `f${i}`);
    const stats = await mineAttention(files, async () => gapFile);
    expect(stats).toMatchObject({ gaps: ATTENTION_MIN_SESSIONS, sessions: ATTENTION_MIN_SESSIONS, medianMinutes: 10 });
  });
  it("returns null below the floor", async () => {
    expect(await mineAttention(["f1"], async () => gapFile)).toBeNull();
  });
  it("skips unreadable files", async () => {
    expect(await mineAttention(["f1"], async () => { throw new Error("gone"); })).toBeNull();
  });
});

describe("attentionSuggestion", () => {
  it("builds a Notification hook suggestion with a stable id", () => {
    const s = attentionSuggestion({ gaps: 12, sessions: 8, medianMinutes: 14 });
    expect(s.payload).toMatchObject({
      type: "hook", event: "Notification", matcher: "permission_prompt|idle_prompt", subcommand: "notify",
    });
    expect(s.rationale).toContain("12");
    expect(s.id).toBe(attentionSuggestion({ gaps: 1, sessions: 5, medianMinutes: 5 }).id);
  });
});
```

Append to `cli/src/core/emit/emit.test.ts`:

```ts
it("hook patch carries the matcher when present", () => {
  const s = { id: "n1", name: "notify-hook", title: "t", rationale: "", confidence: "high" as const,
    evidence: { count: 5, sessions: 5 },
    payload: { type: "hook" as const, event: "Notification", matcher: "permission_prompt|idle_prompt",
      subcommand: "notify", description: "d" } };
  const { settingsPatch } = emitHook(s);
  expect(JSON.parse(settingsPatch).hooks.Notification[0].matcher).toBe("permission_prompt|idle_prompt");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/attention.test.ts src/core/emit/emit.test.ts`
Expected: FAIL — `./attention.js` missing; matcher absent; `notify` unknown subcommand.

- [ ] **Step 3: Implement**

`cli/src/core/types.ts` hook payload:

```ts
  | { type: "hook"; event: string; subcommand: string; description: string; matcher?: string }
```

`cli/src/core/validate.ts`: `KNOWN_SUBCOMMANDS` becomes `new Set(["checkpoint", "scan", "notify"])`; in the hook branch add:

```ts
    if (payload.matcher !== undefined && typeof payload.matcher !== "string") {
      throw new Error("hook payload matcher must be a string");
    }
```

`cli/src/core/emit/hook.ts` — build the group with the matcher:

```ts
  const group: Record<string, unknown> = {
    hooks: [{ type: "command", command: `gradient ${s.payload.subcommand}` }],
  };
  if (s.payload.matcher) group.matcher = s.payload.matcher;
  const patch = { hooks: { [s.payload.event]: [group] } };
```

`cli/src/core/attention.ts`:

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Suggestion } from "./types.js";

export const ATTENTION_MIN_GAP_MS = 300_000; // 5 min
export const ATTENTION_MIN_SESSIONS = 5;

export interface AttentionStats { gaps: number; sessions: number; medianMinutes: number }

interface RawBlock { type?: string; text?: string }
interface RawLine {
  type?: string; isSidechain?: boolean; timestamp?: string;
  message?: { content?: string | RawBlock[] };
}

function textOf(content: string | RawBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(b => b.type === "text").map(b => b.text ?? "").join(" ");
  return "";
}

/** Gap = assistant turn ending in a question, answered ≥5min later in the same transcript. */
export function gapsInLines(lines: string[]): number[] {
  const gaps: number[] = [];
  let pendingQuestionTs: number | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: RawLine;
    try { raw = JSON.parse(line) as RawLine; } catch { continue; }
    if (raw.isSidechain || !raw.timestamp) continue;
    const ts = Date.parse(raw.timestamp);
    if (Number.isNaN(ts)) continue;
    if (raw.type === "assistant") {
      pendingQuestionTs = textOf(raw.message?.content).trim().endsWith("?") ? ts : null;
    } else if (raw.type === "user" && pendingQuestionTs !== null && textOf(raw.message?.content).trim()) {
      const delta = ts - pendingQuestionTs;
      if (delta >= ATTENTION_MIN_GAP_MS) gaps.push(delta);
      pendingQuestionTs = null;
    }
  }
  return gaps;
}

export async function mineAttention(
  files: string[],
  readFn: (p: string) => Promise<string> = p => readFile(p, "utf8"),
): Promise<AttentionStats | null> {
  const all: number[] = [];
  let sessions = 0;
  for (const f of files) {
    let content: string;
    try { content = await readFn(f); } catch { continue; }
    const gaps = gapsInLines(content.split(/\r?\n/));
    if (gaps.length > 0) { sessions++; all.push(...gaps); }
  }
  if (sessions < ATTENTION_MIN_SESSIONS) return null;
  const sorted = [...all].sort((a, b) => a - b);
  const medianMinutes = Math.round(sorted[Math.floor(sorted.length / 2)] / 60_000);
  return { gaps: all.length, sessions, medianMinutes };
}

/** Deterministic suggestion — no LLM involved, stable id, normal review/apply path. */
export function attentionSuggestion(a: AttentionStats): Suggestion {
  return {
    id: createHash("sha1").update("attention:notify").digest("hex").slice(0, 10),
    name: "notify-when-waiting",
    title: "Desktop ping when Claude Code is waiting on you",
    rationale: `You left Claude waiting ≥5 minutes ${a.gaps} time(s) across ${a.sessions} sessions (median ${a.medianMinutes} min). A Notification hook can ping your desktop instead.`,
    evidence: { count: a.gaps, sessions: a.sessions },
    confidence: "high",
    payload: {
      type: "hook", event: "Notification", matcher: "permission_prompt|idle_prompt",
      subcommand: "notify", description: "Desktop notification when Claude needs input",
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/attention.ts cli/src/core/attention.test.ts cli/src/core/types.ts cli/src/core/emit/hook.ts cli/src/core/emit/emit.test.ts cli/src/core/validate.ts
git commit -m "feat(core): attention-gap mining → Notification hook suggestion with matcher"
```

---

### Task R4: Scan wiring + `gradient notify` + CLI + docs

**Files:**
- Create: `cli/src/commands/notify.ts`
- Modify: `cli/src/commands/scan.ts`, `cli/src/cli.ts`, `README.md`
- Test: `cli/src/commands/notify.test.ts` (create), `cli/src/commands/scan.test.ts` (append)

**Interfaces:**
- Consumes: `mineAttention`, `attentionSuggestion` from R3.
- Produces:
  - `notify(deps?: { platform?: NodeJS.Platform; spawnFn?: (cmd: string, args: string[]) => void }): Promise<void>` — fail-open, silent.
  - `scan` appends the attention suggestion (advisory try/catch) before caching; log line `attention: N waits ≥5min across M sessions — notification hook suggested`.
  - CLI: `gradient notify` dispatch (drains stdin, exits 0, no output); HELP line.

- [ ] **Step 1: Write the failing tests** — create `cli/src/commands/notify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { notify, NOTIFY_BODY } from "./notify.js";

describe("notify", () => {
  it("uses osascript on darwin", async () => {
    const calls: [string, string[]][] = [];
    await notify({ platform: "darwin", spawnFn: (c, a) => calls.push([c, a]) });
    expect(calls[0][0]).toBe("osascript");
    expect(calls[0][1].join(" ")).toContain(NOTIFY_BODY);
  });
  it("uses notify-send on linux", async () => {
    const calls: [string, string[]][] = [];
    await notify({ platform: "linux", spawnFn: (c, a) => calls.push([c, a]) });
    expect(calls[0][0]).toBe("notify-send");
  });
  it("no-ops on other platforms and swallows spawn errors", async () => {
    await expect(notify({ platform: "win32", spawnFn: () => { throw new Error("x"); } })).resolves.toBeUndefined();
    await expect(notify({ platform: "darwin", spawnFn: () => { throw new Error("x"); } })).resolves.toBeUndefined();
  });
});
```

Append to `cli/src/commands/scan.test.ts` (transcript fixtures reuse the JSONL-line helpers from `attention.test.ts` — inline the two-line builders):

```ts
it("suggests a notification hook when attention gaps cross the floor", async () => {
  const asst = JSON.stringify({ type: "assistant", timestamp: "2026-07-09T10:00:00Z",
    message: { role: "assistant", content: [{ type: "text", text: "Proceed?" }] } });
  const user = JSON.stringify({ type: "user", timestamp: "2026-07-09T10:10:00Z",
    message: { role: "user", content: "yes" } });
  const files = ["f0", "f1", "f2", "f3", "f4"];
  await writeFile(join(dir, "transcript.jsonl"), `${asst}\n${user}\n`); // real file for readFn default
  const logs: string[] = [];
  const out = await scan(
    { scope: "project", projectPath: dir },
    { backend: null, collectFn: async () => files.map(() => join(dir, "transcript.jsonl")),
      parseFn: async () => [], log: m => logs.push(m) },
  );
  expect(out.some(s => s.payload.type === "hook" && s.payload.event === "Notification")).toBe(true);
  expect(logs.join("\n")).toContain("notification hook suggested");
});
```

(The five collected "files" all point at the same real transcript on disk; `mineAttention` counts a gap-bearing session per file, crossing `ATTENTION_MIN_SESSIONS`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/notify.test.ts src/commands/scan.test.ts`
Expected: FAIL — `./notify.js` missing; no Notification suggestion.

- [ ] **Step 3: Implement**

`cli/src/commands/notify.ts`:

```ts
import { spawn } from "node:child_process";

export const NOTIFY_TITLE = "Claude Code";
export const NOTIFY_BODY = "Claude Code is waiting on you";

export interface NotifyDeps {
  platform?: NodeJS.Platform;
  spawnFn?: (cmd: string, args: string[]) => void;
}

/** Hook target: fire an OS notification and never fail (Spec 9 §2 D5).
 * Static text only — transcript content never reaches the notification. */
export async function notify(deps: NotifyDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawnFn ?? ((cmd, args) => {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => { /* binary missing — fail open */ });
    child.unref();
  });
  try {
    if (platform === "darwin") {
      spawnFn("osascript", ["-e", `display notification ${JSON.stringify(NOTIFY_BODY)} with title ${JSON.stringify(NOTIFY_TITLE)}`]);
    } else if (platform === "linux") {
      spawnFn("notify-send", [NOTIFY_TITLE, NOTIFY_BODY]);
    }
  } catch { /* fail open — the hook must never surface an error */ }
}
```

`cli/src/commands/scan.ts` — after `valid` is built, before the `suggestions.json` write:

```ts
import { mineAttention, attentionSuggestion } from "../core/attention.js";

  try {
    const att = await mineAttention(files);
    if (att && !valid.some(s => s.payload.type === "hook" && s.payload.event === "Notification")) {
      valid.push(attentionSuggestion(att));
      log(`attention: ${att.gaps} waits ≥5min across ${att.sessions} sessions — notification hook suggested`);
    }
  } catch (e) {
    log(`attention check failed: ${(e as Error).message}`); // advisory, never fails the scan
  }
```

`cli/src/cli.ts` — dispatch (mirrors `respond`'s silent contract) and HELP:

```ts
      case "notify": {
        await readStdin(); // drain hook stdin; content unused
        await notify();
        return 0;
      }
```

with a static import alongside the file's other command imports: `import { notify } from "./commands/notify.js";`

HELP gains: `  gradient notify               (hook target) desktop ping — installed via a suggested Notification hook`

`README.md` — one bullet in the autopilot/hooks area: gradient can suggest a `Notification` desktop ping when your history shows long waiting-on-you gaps; approve it in `gradient review` like anything else.

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/notify.ts cli/src/commands/notify.test.ts cli/src/commands/scan.ts cli/src/commands/scan.test.ts cli/src/cli.ts README.md
git commit -m "feat(cli): gradient notify + attention-gap suggestion wiring"
```

---

## Execution notes (2026-07-10)

All four tasks are implemented. The execution preserved the plan's user-visible
contract and adapted it to the later multi-assistant and bundle work already on
main:

- `review` keeps its current config/options parameter; `Clarifier` is an option,
  so Claude/Codex target fan-out and cheap-model settings remain intact.
- Declining a clarification skips the unresolved suggestion immediately. This
  enforces the spec's “flagged and unapplied” rule even if a custom approval
  prompter would otherwise approve it.
- Clarification provenance is persisted before artifact I/O, so a failed target
  write cannot erase the user's choice. Cache validation accepts only the two
  valid states: flagged/unresolved or high/chosen.
- Attention mining reads Claude transcripts only. Codex prompts remain part of
  shared habit mining, but cannot create a Claude lifecycle-hook suggestion.
- Question-tail detection reuses Phase C's detector; duplicate transcript paths
  cannot inflate the five-session floor, and even-sized medians use the
  conventional midpoint.
- Hook matchers survive both direct emission and Phase E plugin bundling. The
  installed binary also dispatches `notify` through a lightweight path instead
  of loading the LLM-facing CLI graph.
- Release dogfooding upgraded Phase E's Claude manifest with author metadata;
  generated bundles now pass both `claude plugin validate --strict` and the
  Codex plugin validator.
- Current Claude Code documentation confirms Notification matchers
  `permission_prompt` and `idle_prompt`, including `|`-separated exact matching.
- Final verification: 515 tests, typecheck, build, zero runtime audit findings,
  packed global install, interactive clarification into both assistant targets,
  matched-hook bundle/apply, real and missing notifier paths, and both plugin
  validators. A read-only seven-day dogfood pass found 14 qualifying waits in
  11 sessions (median 18 minutes).
