# gradient v2 Phase A — Honest Input & Skills Output — Implementation Plan

**Status:** Complete. Unchecked boxes below preserve the original test-first
execution recipe.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Machine-generated prompts can never become "habits" (classifier + template-flood guard), and gradient's default artifact becomes a Claude Code skill (`.claude/skills/<name>/SKILL.md`) with mined trigger phrasings in its `description`, plus `gradient migrate` to convert existing command artifacts. Spec: `docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md` §3.

**Architecture:** `filter.ts` grows a `classifyPrompt` layer (per-prompt classes) and a post-cluster template-flood guard consumed by `scan`. `emit/` gains a skill emitter selected by `emit(s, { target })`; `apply`/`review`/`remove` learn the `skill` artifact type. `detect`'s prompt gains `triggers` (the merge logic already exists via `sourceSignatures` — do not re-add it).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

- Spec references are to `2026-07-06-gradient-v2-funnel-design.md`. Execute after the Spec 3 (`gradient.md`) plan has merged; the only shared file region is `scan.ts` logging.
- **Constants (spec §3 A1, pinned here):** `TEMPLATE_MIN_CHARS = 240`, `TEMPLATE_MIN_COUNT = 25`, template flood additionally requires `sessions >= ceil(count * 0.9)`.
- **Config keys:** `ignorePatterns?: string[]` (regex sources; invalid ones skipped silently), `emitTarget?: "skill" | "command"` (default `"skill"`).
- **Skill path:** exactly `.claude/skills/<sanitized name>/SKILL.md`; frontmatter values emitted via `JSON.stringify` (same injection guard as `emitCommand`); never set `disable-model-invocation`.
- `redact()` runs before anything reaches an LLM (unchanged); all writes stay inside `.claude/` via `assertInside`.
- Tests: vitest with injected deps, no network, no real `claude`. Run from `cli/`: `npm test`, `npm run typecheck`.
- Branch: `spec/v2-phase-a`. Commit after every task.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/filter.ts` (modify) | `PromptClass`, `classifyPrompt`, `classifyPrompts`, `compileIgnorePatterns`, `isTemplateFlood` |
| `cli/src/core/types.ts` (modify) | `Config.ignorePatterns`, `Config.emitTarget`, `ArtifactType` += `"skill"`, command payload `triggers?` |
| `cli/src/commands/scan.ts` (modify) | pass ignore patterns to filter; exclude template floods post-cluster (logged) |
| `cli/src/core/emit/skill.ts` (create) | command payload → SKILL.md content |
| `cli/src/core/emit/index.ts` (modify) | `EmitTarget`, `emit(s, { target })`, `EmitResult` += skill |
| `cli/src/core/validate.ts` (modify) | optional `triggers` validation |
| `cli/src/core/apply.ts` (modify) | write skill artifacts; manifest `type: "skill"` |
| `cli/src/commands/apply.ts`, `review.ts` (modify) | resolve `emitTarget` from config |
| `cli/src/commands/remove.ts` (modify) | remove emptied skill directory |
| `cli/src/core/detect.ts` (modify) | prompt: skills wording + `triggers` |
| `cli/src/commands/migrate.ts` (create) | manifest-tracked commands → skills, `--dry-run` |
| `cli/src/cli.ts` (modify) | `migrate` dispatch, HELP wording |
| `cli/src/core/ui.ts` (modify) | `kindLabel` for `skill` |
| `README.md`, `cli/README.md` (modify) | skills wording |

---

### Task A1: Prompt classifier + config ignore patterns

**Files:**
- Modify: `cli/src/core/filter.ts`
- Modify: `cli/src/core/types.ts`
- Test: `cli/src/core/filter.test.ts` (append)

**Interfaces:**
- Consumes: existing `INJECTED_PATTERNS`, `Turn`.
- Produces (later tasks and Phases C/D rely on these exact names):
  - `type PromptClass = "human" | "injected" | "continuation" | "notification"`
  - `classifyPrompt(text: string, ignore?: RegExp[]): PromptClass`
  - `classifyPrompts(turns: Turn[], ignore?: RegExp[]): Record<PromptClass, Turn[]>`
  - `compileIgnorePatterns(raw?: string[]): RegExp[]` (invalid regex sources skipped)
  - `filterPrompts(turns: Turn[], ignore?: RegExp[]): Turn[]` (signature widened, back-compatible)
  - `Config.ignorePatterns?: string[]`

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/filter.test.ts`:

```ts
import { classifyPrompt, classifyPrompts, compileIgnorePatterns, filterPrompts } from "./filter.js";
import type { Turn } from "./types.js";

const turn = (text: string): Turn =>
  ({ ts: "2026-07-01T00:00:00Z", project: "p", role: "user", sessionId: "s1", text });

describe("classifyPrompt", () => {
  it("classifies ordinary prompts as human", () => {
    expect(classifyPrompt("fix the login bug")).toBe("human");
  });
  it("keeps existing injected patterns as injected", () => {
    expect(classifyPrompt("<command-name>/compact</command-name>")).toBe("injected");
    expect(classifyPrompt("Caveat: The messages below were generated")).toBe("injected");
  });
  it("classifies continuation summaries", () => {
    expect(classifyPrompt("This session is being continued from a previous conversation that ran out of context.")).toBe("continuation");
  });
  it("classifies task notifications", () => {
    expect(classifyPrompt("<task-notification><task-id>x</task-id></task-notification>")).toBe("notification");
  });
  it("applies user ignore patterns as injected", () => {
    const ignore = compileIgnorePatterns(["^review this change for security vulnerabilities"]);
    expect(classifyPrompt("Review this change for security vulnerabilities. Changed files: a.ts", ignore)).toBe("injected");
  });
  it("compileIgnorePatterns skips invalid regexes", () => {
    expect(compileIgnorePatterns(["[unclosed", "^ok$"])).toHaveLength(1);
  });
});

describe("classifyPrompts / filterPrompts", () => {
  it("buckets by class and filterPrompts keeps only human", () => {
    const turns = [turn("do the thing"), turn("This session is being continued from a previous conversation."), turn("<task-notification>x</task-notification>")];
    const buckets = classifyPrompts(turns);
    expect(buckets.human).toHaveLength(1);
    expect(buckets.continuation).toHaveLength(1);
    expect(buckets.notification).toHaveLength(1);
    expect(filterPrompts(turns)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/filter.test.ts`
Expected: FAIL — `classifyPrompt` is not exported.

- [ ] **Step 3: Implement** — in `cli/src/core/filter.ts`, keep `INJECTED_PATTERNS` and `isInjected` as they are, then add:

```ts
export type PromptClass = "human" | "injected" | "continuation" | "notification";

const CONTINUATION_RE = /^this session is being continued from a previous/i;
const NOTIFICATION_RE = /^<task-notification>/i;

export function compileIgnorePatterns(raw?: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of raw ?? []) {
    try { out.push(new RegExp(src, "i")); } catch { /* invalid pattern — skip */ }
  }
  return out;
}

export function classifyPrompt(text: string, ignore: RegExp[] = []): PromptClass {
  const t = text.trim();
  if (!t || INJECTED_PATTERNS.some(re => re.test(t))) return "injected";
  if (CONTINUATION_RE.test(t)) return "continuation";
  if (NOTIFICATION_RE.test(t)) return "notification";
  if (ignore.some(re => re.test(t))) return "injected";
  return "human";
}

export function classifyPrompts(turns: Turn[], ignore: RegExp[] = []): Record<PromptClass, Turn[]> {
  const out: Record<PromptClass, Turn[]> = { human: [], injected: [], continuation: [], notification: [] };
  for (const t of turns) {
    if (t.role !== "user" || t.text === undefined) continue;
    out[classifyPrompt(t.text, ignore)].push(t);
  }
  return out;
}
```

Rewrite `filterPrompts` to delegate:

```ts
export function filterPrompts(turns: Turn[], ignore: RegExp[] = []): Turn[] {
  return classifyPrompts(turns, ignore).human;
}
```

In `cli/src/core/types.ts`, add to `Config`:

```ts
  /** Extra regexes (source strings) classified as machine-injected during mining. */
  ignorePatterns?: string[];
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/filter.test.ts && npm run typecheck`
Expected: PASS (existing `filterPrompts` tests must stay green — the widened signature is back-compatible).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/filter.ts cli/src/core/filter.test.ts cli/src/core/types.ts
git commit -m "feat(core): prompt classifier — continuation/notification/ignore-pattern classes"
```

---

### Task A2: Template-flood guard + scan wiring + regression fixture

**Files:**
- Modify: `cli/src/core/filter.ts`
- Modify: `cli/src/commands/scan.ts`
- Test: `cli/src/core/filter.test.ts`, `cli/src/commands/scan.test.ts` (append)

**Interfaces:**
- Consumes: `Candidate` (from `types.ts`), `cluster()` output in `scan`.
- Produces:
  - `TEMPLATE_MIN_CHARS = 240`, `TEMPLATE_MIN_COUNT = 25` (exported consts)
  - `isTemplateFlood(c: Candidate): boolean`
  - `scan` filters flood candidates before `detect`, logging `excluded N machine-template pattern(s)`.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/filter.test.ts`:

```ts
import { isTemplateFlood, TEMPLATE_MIN_CHARS, TEMPLATE_MIN_COUNT } from "./filter.js";
import type { Candidate } from "./types.js";

const cand = (over: Partial<Candidate>): Candidate => ({
  kind: "unknown", signature: "x".repeat(300), examples: [], count: 30,
  sessions: 30, sessionIds: [], confidence: "high", ...over,
});

describe("isTemplateFlood", () => {
  it("flags long, high-volume, once-per-session clusters", () => {
    // The dogfood case: 1,318 CI-injected security-review prompts, one per session.
    expect(isTemplateFlood(cand({ count: 1318, sessions: 1318 }))).toBe(true);
  });
  it("spares short prompts regardless of volume (human habits are short)", () => {
    expect(isTemplateFlood(cand({ signature: "continue", count: 200, sessions: 100 }))).toBe(false);
  });
  it("spares low counts (single pastes, small repeats)", () => {
    expect(isTemplateFlood(cand({ count: TEMPLATE_MIN_COUNT - 1, sessions: TEMPLATE_MIN_COUNT - 1 }))).toBe(false);
  });
  it("spares within-session repetition (occurrences ≫ sessions = a human habit)", () => {
    expect(isTemplateFlood(cand({ count: 60, sessions: 10 }))).toBe(false);
  });
});
```

Append to `cli/src/commands/scan.test.ts` (follow that file's existing pattern of injected `collectFn`/`parseFn`/`backend: null` deps):

```ts
it("excludes template floods from detection and logs the exclusion", async () => {
  const flood = "Review this change for security vulnerabilities. Changed files (you may read these and any other file in the repo): " + "x".repeat(200);
  const turns = Array.from({ length: 30 }, (_, i) => ({
    ts: `2026-07-0${(i % 9) + 1}T00:00:00Z`, project: "p", role: "user" as const,
    sessionId: `s${i}`, text: flood,
  }));
  const logs: string[] = [];
  const out = await scan(
    { scope: "project", projectPath: dir },           // dir: mkdtemp'd tmp dir as in existing tests
    { backend: null, collectFn: async () => ["f"], parseFn: async () => turns, log: m => logs.push(m) },
  );
  expect(out).toHaveLength(0);
  expect(logs.join("\n")).toContain("excluded 1 machine-template pattern(s)");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/filter.test.ts src/commands/scan.test.ts`
Expected: FAIL — `isTemplateFlood` not exported; scan log line missing.

- [ ] **Step 3: Implement** — append to `cli/src/core/filter.ts`:

```ts
import type { Candidate } from "./types.js"; // merge into the file's existing type imports

/** Template floods: long, voluminous, ~once-per-session → machine-injected, not a habit (spec §3 A1). */
export const TEMPLATE_MIN_CHARS = 240;
export const TEMPLATE_MIN_COUNT = 25;

export function isTemplateFlood(c: Candidate): boolean {
  return (
    c.signature.length > TEMPLATE_MIN_CHARS &&
    c.count >= TEMPLATE_MIN_COUNT &&
    c.sessions >= Math.ceil(c.count * 0.9)
  );
}
```

In `cli/src/commands/scan.ts`: import `compileIgnorePatterns, isTemplateFlood` from `../core/filter.js`; thread patterns and the guard through the pipeline (config is already loaded before use — move the `loadConfig` line above the `filterPrompts` call):

```ts
const config = deps.config ?? (await loadConfig(opts.home));
const ignore = compileIgnorePatterns(config.ignorePatterns);
const prompts = filterPrompts(turns, ignore);
log(`prompts: ${prompts.length} after filtering injected text`);
```

and after `cluster(kept)`:

```ts
const clustered = cluster(kept);
const floods = clustered.filter(isTemplateFlood);
const candidates = clustered.filter(c => !isTemplateFlood(c));
if (floods.length > 0) log(`excluded ${floods.length} machine-template pattern(s) (CI/hook-injected, not habits)`);
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS, including all pre-existing scan tests.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/filter.ts cli/src/core/filter.test.ts cli/src/commands/scan.ts cli/src/commands/scan.test.ts
git commit -m "feat(scan): template-flood guard — CI-injected prompts can't become suggestions"
```

---

### Task A3: Skill emitter + emit target dispatch + `triggers`

**Files:**
- Create: `cli/src/core/emit/skill.ts`
- Modify: `cli/src/core/emit/index.ts`, `cli/src/core/types.ts`, `cli/src/core/validate.ts`
- Test: `cli/src/core/emit/emit.test.ts` (append), `cli/src/core/validate.test.ts` (append)

**Interfaces:**
- Consumes: `sanitizeName` (`core/security.ts`), `Suggestion`.
- Produces:
  - `types.ts`: `ArtifactType = "command" | "loop" | "hook" | "skill"`; command payload gains `triggers?: string[]`; `Config.emitTarget?: "skill" | "command"`.
  - `emit/skill.ts`: `emitSkill(s: Suggestion): { path: string; content: string }`
  - `emit/index.ts`: `type EmitTarget = "skill" | "command"`; `emit(s: Suggestion, opts?: { target?: EmitTarget }): EmitResult`; `EmitResult` gains `{ kind: "skill"; path: string; content: string }`. Default target is `"skill"`.
  - `validate.ts`: `payload.triggers`, when present, must be an array of strings.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/emit/emit.test.ts`:

```ts
import { emitSkill } from "./skill.js";
import { emit } from "./index.js";

const skillSug = {
  id: "1", name: "lgtm", title: "Approve and merge the current PR",
  rationale: "", evidence: { count: 6, sessions: 4 }, confidence: "high" as const,
  payload: { type: "command" as const, commandName: "lgtm", body: "Approve and merge.", triggers: ["lgtm", "looks good"] },
};

describe("emitSkill", () => {
  it("writes SKILL.md under .claude/skills/<name>/ with triggers in the description", () => {
    const { path, content } = emitSkill(skillSug);
    expect(path).toBe(".claude/skills/lgtm/SKILL.md");
    expect(content).toContain('description: "Approve and merge the current PR. Use when the user says things like: \\"lgtm\\", \\"looks good\\"."');
    expect(content.endsWith("Approve and merge.\n")).toBe(true);
  });
  it("omits the trigger clause when there are no triggers", () => {
    const { content } = emitSkill({ ...skillSug, payload: { type: "command", commandName: "lgtm", body: "b" } });
    expect(content).toContain('description: "Approve and merge the current PR"');
    expect(content).not.toContain("Use when the user says");
  });
  it("frontmatter cannot be injected via title or trigger newlines/quotes", () => {
    const { content } = emitSkill({ ...skillSug, title: 'x"\nmodel: opus', payload: { ...skillSug.payload, triggers: ['a"\nagent: evil'] } });
    const fm = content.split("---")[1];
    expect(fm).not.toMatch(/^model:/m);
    expect(fm).not.toMatch(/^agent:/m);
  });
});

describe("emit target dispatch", () => {
  it("command payloads emit as skills by default", () => {
    expect(emit(skillSug).kind).toBe("skill");
  });
  it("emitTarget command preserves the legacy path", () => {
    const r = emit(skillSug, { target: "command" });
    expect(r.kind).toBe("command");
    if (r.kind === "command") expect(r.path).toBe(".claude/commands/lgtm.md");
  });
});
```

Append to `cli/src/core/validate.test.ts`:

```ts
it("rejects non-string triggers", () => {
  const s = { id: "1", name: "n", title: "t", rationale: "r", confidence: "high",
    payload: { type: "command", commandName: "n", body: "b", triggers: [1] } };
  expect(() => validateSuggestion(s)).toThrow(/triggers/);
});
it("accepts string triggers and absent triggers", () => {
  const base = { id: "1", name: "n", title: "t", rationale: "r", confidence: "high",
    payload: { type: "command", commandName: "n", body: "b" } };
  expect(() => validateSuggestion(base)).not.toThrow();
  expect(() => validateSuggestion({ ...base, payload: { ...base.payload, triggers: ["x"] } })).not.toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/emit/emit.test.ts src/core/validate.test.ts`
Expected: FAIL — `./skill.js` module not found.

- [ ] **Step 3: Implement**

`cli/src/core/types.ts`:

```ts
export type ArtifactType = "command" | "loop" | "hook" | "skill";
// command payload:
  | { type: "command"; commandName: string; body: string; triggers?: string[] }
// Config gains:
  /** Artifact format for command-type suggestions. Default "skill". */
  emitTarget?: "skill" | "command";
```

`cli/src/core/emit/skill.ts`:

```ts
import type { Suggestion } from "../types.js";
import { sanitizeName } from "../security.js";

/** Command payload → model-invokable Claude Code skill. Triggers (the mined
 * phrasings) go into the description so Claude auto-invokes it (spec §3 A2). */
export function emitSkill(s: Suggestion): { path: string; content: string } {
  if (s.payload.type !== "command") throw new Error("emitSkill needs a command payload");
  const name = sanitizeName(s.payload.commandName);
  const title = s.title.replace(/[\r\n]+/g, " ").trim();
  const triggers = (s.payload.triggers ?? [])
    .map(t => JSON.stringify(t.replace(/[\r\n]+/g, " ").trim()))
    .join(", ");
  const description = triggers ? `${title}. Use when the user says things like: ${triggers}.` : title;
  const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${s.payload.body}\n`;
  return { path: `.claude/skills/${name}/SKILL.md`, content };
}
```

`cli/src/core/emit/index.ts`:

```ts
import { emitSkill } from "./skill.js";

export type EmitTarget = "skill" | "command";
export type EmitResult =
  | { kind: "command"; path: string; content: string }
  | { kind: "skill"; path: string; content: string }
  | { kind: "loop"; command: string }
  | { kind: "hook"; settingsPatch: string };

export function emit(s: Suggestion, opts: { target?: EmitTarget } = {}): EmitResult {
  switch (s.payload.type) {
    case "command":
      return (opts.target ?? "skill") === "command"
        ? { kind: "command", ...emitCommand(s) }
        : { kind: "skill", ...emitSkill(s) };
    case "loop": return { kind: "loop", ...emitLoop(s) };
    case "hook": return { kind: "hook", ...emitHook(s) };
  }
}
```

`cli/src/core/validate.ts` — inside the `payload.type === "command"` branch:

```ts
if (payload.triggers !== undefined) {
  if (!Array.isArray(payload.triggers) || payload.triggers.some(t => typeof t !== "string")) {
    throw new Error("command payload triggers must be an array of strings");
  }
}
```

(`TYPES` in `validate.ts` stays `command|loop|hook` — `"skill"` is an *artifact* type, not a payload type.)

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/types.ts cli/src/core/emit/skill.ts cli/src/core/emit/index.ts cli/src/core/emit/emit.test.ts cli/src/core/validate.ts cli/src/core/validate.test.ts
git commit -m "feat(emit): skills as default artifact — SKILL.md with mined trigger descriptions"
```

---

### Task A4: apply/review/remove learn the skill artifact

**Files:**
- Modify: `cli/src/core/apply.ts`, `cli/src/commands/apply.ts`, `cli/src/commands/review.ts`, `cli/src/commands/remove.ts`, `cli/src/core/ui.ts`
- Test: `cli/src/core/apply.test.ts` (append), `cli/src/commands/manage.test.ts` (append)

**Interfaces:**
- Consumes: `emit(s, { target })`, `EmitTarget`, `loadConfig`.
- Produces:
  - `applySuggestion(s, projectDir, opts?: { emitTarget?: EmitTarget }): Promise<ApplyResult>` — command payloads write `.claude/skills/<name>/SKILL.md` by default; manifest entry `type` comes from the emit result kind (`"skill"` or `"command"`), other payloads unchanged.
  - `applyByIds` and `review` resolve `emitTarget` from `config.emitTarget ?? "skill"` and pass it through.
  - `remove` deletes an emptied `.claude/skills/<name>/` directory after unlinking SKILL.md.
  - `ui.ts` `kindLabel` renders `"skill"`.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/apply.test.ts` (reuse that file's mkdtemp/project-dir helpers):

```ts
it("writes a SKILL.md by default and records manifest type skill", async () => {
  const s = { id: "9", name: "lgtm", title: "t", rationale: "", confidence: "high" as const,
    evidence: { count: 3, sessions: 2 },
    payload: { type: "command" as const, commandName: "lgtm", body: "b", triggers: ["lgtm"] } };
  const r = await applySuggestion(s, dir);
  expect(r.written).toContain(join(".claude", "skills", "lgtm", "SKILL.md"));
  const manifest = await loadManifest(dir);
  expect(manifest[0]).toMatchObject({ name: "lgtm", type: "skill" });
});

it("honors emitTarget command", async () => {
  const s = { id: "9", name: "lgtm", title: "t", rationale: "", confidence: "high" as const,
    evidence: { count: 3, sessions: 2 },
    payload: { type: "command" as const, commandName: "lgtm", body: "b" } };
  const r = await applySuggestion(s, dir, { emitTarget: "command" });
  expect(r.written).toContain(join(".claude", "commands", "lgtm.md"));
  expect((await loadManifest(dir))[0].type).toBe("command");
});
```

Append to `cli/src/commands/manage.test.ts`:

```ts
it("remove deletes the skill file and its emptied directory", async () => {
  const s = { id: "9", name: "lgtm", title: "t", rationale: "", confidence: "high" as const,
    evidence: { count: 3, sessions: 2 },
    payload: { type: "command" as const, commandName: "lgtm", body: "b" } };
  await applySuggestion(s, dir);
  expect(await remove(dir, "lgtm")).toBe(true);
  await expect(stat(join(dir, ".claude", "skills", "lgtm"))).rejects.toThrow(); // dir gone
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/apply.test.ts src/commands/manage.test.ts`
Expected: FAIL — skill path not written / directory left behind.

- [ ] **Step 3: Implement**

`cli/src/core/apply.ts` — replace the body of `applySuggestion`:

```ts
import type { EmitTarget } from "./emit/index.js";

export async function applySuggestion(
  s: Suggestion,
  projectDir: string,
  opts: { emitTarget?: EmitTarget } = {},
): Promise<ApplyResult> {
  const result = emit(s, { target: opts.emitTarget });
  let written: string | undefined;
  let printed: string | undefined;
  let type: ArtifactType;

  if (result.kind === "command" || result.kind === "skill") {
    const abs = join(projectDir, result.path);
    assertInside(join(projectDir, ".claude"), abs);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, result.content);
    written = abs;
    type = result.kind;
  } else if (result.kind === "loop") {
    printed = result.command;
    type = "loop";
  } else {
    printed = result.settingsPatch;
    type = "hook";
  }
  // manifest entry construction unchanged, using `type`
```

`cli/src/commands/apply.ts` and `cli/src/commands/review.ts` — resolve the target once and pass it (both already import from sibling modules; add `loadConfig` import):

```ts
const config = await loadConfig();
const emitTarget = config.emitTarget ?? "skill";
// ...applySuggestion(s, projectDir, { emitTarget })
```

`cli/src/commands/remove.ts` — after the existing `unlink`:

```ts
import { rmdir } from "node:fs/promises";
import { dirname } from "node:path";
// inside the entry.path branch, after unlink:
if (entry.type === "skill") {
  try { await rmdir(dirname(abs)); } catch { /* not empty or already gone — leave it */ }
}
```

`cli/src/core/ui.ts` — extend `kindLabel` with a `skill` case, matching however the existing map renders `command`/`loop`/`hook` (same styling helper, label text `skill`).

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/apply.ts cli/src/core/apply.test.ts cli/src/commands/apply.ts cli/src/commands/review.ts cli/src/commands/remove.ts cli/src/commands/manage.test.ts cli/src/core/ui.ts
git commit -m "feat(apply): skill artifacts end-to-end — write, manifest, clean remove"
```

---

### Task A5: detect prompt — skills wording + triggers

**Files:**
- Modify: `cli/src/core/detect.ts`
- Test: `cli/src/core/detect.test.ts` (append)

**Interfaces:**
- Consumes: existing `buildDetectPrompt`, `detect` (cluster merge via `sourceSignatures` **already exists — do not re-add**).
- Produces: system prompt asks for `triggers` on command payloads; degraded (`no-LLM`) path passes `triggers: [signature]` through `candidateToCommand`.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/detect.test.ts`:

```ts
it("asks the model for triggers on command payloads", () => {
  const { system } = buildDetectPrompt([]);
  expect(system).toContain("triggers");
  expect(system).toContain("skill");           // wording: command → emitted as a skill
});

it("degraded path seeds triggers from the signature", () => {
  const c = { kind: "unknown" as const, signature: "lgtm", examples: ["lgtm"],
    count: 5, sessions: 3, sessionIds: ["a", "b", "c"], confidence: "high" as const };
  const s = candidateToCommand(c);
  expect(s.payload).toMatchObject({ type: "command", triggers: ["lgtm"] });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/detect.test.ts`
Expected: FAIL on both.

- [ ] **Step 3: Implement** — in `cli/src/core/detect.ts`:

In `candidateToCommand`, add `triggers: [c.signature]` to the payload.

In `buildDetectPrompt`'s `system` string, change the command clause and payload schema (leave the existing merge/sourceSignatures sentences untouched):

```ts
"For each cluster decide a type: 'command' (a repeated instruction → emitted as a reusable Claude Code skill), " +
// ...existing loop/hook sentences unchanged...
"For command payloads include triggers: the distinct short phrasings the user actually typed, taken from every merged cluster's signature (e.g. [\"lgtm\",\"looks good\"]). " +
"Respond ONLY with JSON: {\"suggestions\":[{sourceSignatures,name,title,rationale,confidence,payload}]} where payload is one of " +
"{type:'command',commandName,body,triggers?} | {type:'loop',instruction,cadence?} | {type:'hook',event:'PreCompact',subcommand:'checkpoint',description}. " +
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/detect.ts cli/src/core/detect.test.ts
git commit -m "feat(detect): request mined triggers; command suggestions emit as skills"
```

---

### Task A6: `gradient migrate` + CLI wiring + docs wording

**Files:**
- Create: `cli/src/commands/migrate.ts`
- Test: `cli/src/commands/migrate.test.ts` (create)
- Modify: `cli/src/cli.ts`, `README.md`, `cli/README.md`

**Interfaces:**
- Consumes: `loadManifest`, `addEntry` (`core/manifest.ts`), `emitSkill`-style content building, `assertInside`, `sanitizeName`.
- Produces:
  - `migrate(projectDir: string, opts?: { dryRun?: boolean }): Promise<{ migrated: string[]; skipped: string[] }>` — for each manifest entry with `type: "command"` and a real `path`: read the old file, split frontmatter (`description:` value, JSON-string or raw) from body, write `.claude/skills/<name>/SKILL.md`, update the manifest entry to `{ type: "skill", path: <new abs path> }`, unlink the old file. Missing/unreadable old file → `skipped`. `dryRun` reports without writing.
  - CLI: `gradient migrate [--dry-run]`; HELP line added; `--dry-run` added to `parseCliArgs` options.

- [ ] **Step 1: Write the failing tests** — create `cli/src/commands/migrate.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "./migrate.js";
import { addEntry, loadManifest } from "../core/manifest.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "grad-mig-")); });

async function seedCommand(name: string): Promise<string> {
  const p = join(dir, ".claude", "commands", `${name}.md`);
  await mkdir(join(dir, ".claude", "commands"), { recursive: true });
  await writeFile(p, `---\ndescription: "Fix the push"\n---\nDo the fix.\n`);
  await addEntry(dir, { name, type: "command", path: p, createdAt: "2026-07-01", suggestionId: "x" });
  return p;
}

describe("migrate", () => {
  it("converts a manifest-tracked command into a skill and deletes the old file", async () => {
    const old = await seedCommand("fix-push");
    const r = await migrate(dir);
    expect(r.migrated).toEqual(["fix-push"]);
    const skill = await readFile(join(dir, ".claude", "skills", "fix-push", "SKILL.md"), "utf8");
    expect(skill).toContain('description: "Fix the push"');
    expect(skill).toContain("Do the fix.");
    await expect(stat(old)).rejects.toThrow();
    expect((await loadManifest(dir))[0]).toMatchObject({ name: "fix-push", type: "skill" });
  });
  it("dry-run reports but writes nothing", async () => {
    const old = await seedCommand("fix-push");
    const r = await migrate(dir, { dryRun: true });
    expect(r.migrated).toEqual(["fix-push"]);
    await expect(stat(old)).resolves.toBeTruthy();
    expect((await loadManifest(dir))[0].type).toBe("command");
  });
  it("skips entries whose file is gone and non-command entries", async () => {
    await addEntry(dir, { name: "ghost", type: "command", path: join(dir, ".claude", "commands", "ghost.md"), createdAt: "2026-07-01", suggestionId: "y" });
    await addEntry(dir, { name: "a-loop", type: "loop", path: "", createdAt: "2026-07-01", suggestionId: "z" });
    const r = await migrate(dir);
    expect(r.migrated).toEqual([]);
    expect(r.skipped).toEqual(["ghost"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/migrate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `cli/src/commands/migrate.ts`:

```ts
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { loadManifest, addEntry } from "../core/manifest.js";
import { assertInside, sanitizeName } from "../core/security.js";

export interface MigrateResult { migrated: string[]; skipped: string[] }

/** Lenient split of a command file: description from frontmatter (JSON string or raw), body after it. */
export function splitCommandFile(raw: string): { description: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { description: "", body: raw };
  const descLine = m[1].split("\n").find(l => l.startsWith("description:"));
  let description = descLine ? descLine.slice("description:".length).trim() : "";
  if (description.startsWith('"')) {
    try { description = JSON.parse(description) as string; } catch { /* keep raw */ }
  }
  return { description, body: raw.slice(m[0].length) };
}

export async function migrate(projectDir: string, opts: { dryRun?: boolean } = {}): Promise<MigrateResult> {
  const migrated: string[] = [];
  const skipped: string[] = [];
  for (const entry of await loadManifest(projectDir)) {
    if (entry.type !== "command" || !entry.path) continue;
    let raw: string;
    try { raw = await readFile(entry.path, "utf8"); } catch { skipped.push(entry.name); continue; }
    const { description, body } = splitCommandFile(raw);
    const name = sanitizeName(entry.name);
    const newAbs = join(projectDir, ".claude", "skills", name, "SKILL.md");
    assertInside(join(projectDir, ".claude"), newAbs);
    migrated.push(entry.name);
    if (opts.dryRun) continue;
    await mkdir(dirname(newAbs), { recursive: true });
    await writeFile(newAbs, `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`);
    await addEntry(projectDir, { ...entry, type: "skill", path: newAbs }); // addEntry replaces by name
    await unlink(entry.path).catch(() => { /* already gone */ });
  }
  return { migrated, skipped };
}
```

`cli/src/cli.ts`: add `"dry-run": { type: "boolean" }` to `parseCliArgs` options; add the dispatch case and a HELP line `gradient migrate [--dry-run]   convert generated commands to skills`:

```ts
case "migrate": {
  const r = await migrate(projectDir, { dryRun: !!flags["dry-run"] });
  for (const n of r.migrated) log(`${c.ok(flags["dry-run"] ? "would migrate" : "migrated")} ${n}`);
  for (const n of r.skipped) log(c.muted(`skipped ${n} (file missing)`));
  return 0;
}
```

Docs wording (same commit): in `README.md` and `cli/README.md`, replace "slash commands" phrasing for generated artifacts with "skills (auto-invoked slash commands)" in the Quickstart/How-it-works lines, and add `migrate` to the command list. Keep the Status section rewrite for the end of Phase A (this commit).

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/migrate.ts cli/src/commands/migrate.test.ts cli/src/cli.ts README.md cli/README.md
git commit -m "feat(cli): gradient migrate — convert generated commands to skills; docs wording"
```

---

## Execution notes (2026-07-09)

- **A3 exhaustiveness:** adding `"skill"` to `ArtifactType` required minimal
  compile-time handling in `apply.ts` and `ui.ts` during A3. A4 then completed
  the intended manifest type, config dispatch, and removal behavior.
- **A4 test isolation:** `applyByIds` and `review` accept an optional `home` so
  config-dependent tests never read the developer's real gradient config.
- **A6 migration hardening:** migration resolves legacy relative manifest
  paths, parses CRLF frontmatter, refuses tampered sources outside `.claude`,
  and skips collisions with hand-written skills. These preserve the spec's
  gradient-owned-files boundary while keeping `--dry-run` side-effect free.
- **Final review safety fix:** apply now overwrites only the same path already
  owned under the same manifest name; a same-named hand-written skill is never
  replaced or subsequently made removable by gradient.
- **Validation alignment:** the scan regression now exercises all 1,318
  redacted security-review events, template thresholds are pinned at 240
  characters / 25 occurrences / 90% session spread, and scan wiring for
  `ignorePatterns` has direct coverage.
- **Spec clarification:** `ci-template` remains a post-cluster candidate
  classification, not a per-turn `PromptClass`, because it depends on aggregate
  occurrence and session counts.
