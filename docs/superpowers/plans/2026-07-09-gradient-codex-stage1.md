# gradient — Codex Target Stage 1 & Cheap-Model Skills — Implementation Plan

**Status:** Complete. Unchecked boxes below preserve the original test-first
execution recipe.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apply` fans skill artifacts out to every configured assistant (`targets: ["claude-code", "codex"]`), tracked per-target in the manifest and cleanly removable; mechanical skills carry a cheap-model frontmatter the reviewer sees before approving. Spec: `docs/superpowers/specs/2026-07-09-gradient-codex-and-cost-design.md` (Component 1 **Stage 1** + Component 2's mechanical-skill flag).

**Follow-up completed:** Stage 2 (Codex session mining) and the `insights` token-cost section are implemented by `2026-07-09-gradient-codex-stage2-cost.md`.

**Architecture:** `emit()` gains an `assistant` dimension; a new `emit/codex-skill.ts` shares the description builder with the Claude skill emitter. `applySuggestion` loops the resolved targets, writing under `.claude/` or `.agents/` with per-root containment, one manifest entry per (name, target). The detect judge flags `mechanical` command payloads; `emitSkill` adds `model:` only for those, and `review` prints the choice.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

- **Execute after Spec 4 Phase A merges** — this plan modifies A3's `emit/skill.ts` + `emit/index.ts` (`emit(s, { target })`) and A4's `applySuggestion(s, projectDir, opts)`.
- **Codex skills path (verified 2026-07-09):** current Codex docs specify repository skills under `.agents/skills`; the implementation exports `CODEX_SKILLS_DIR = ".agents/skills"`. The earlier `.codex/skills` assumption was not implemented.
- **Config keys:** `targets?: ("claude-code" | "codex")[]` (default `["claude-code"]`; unknown values are a load-time error); `cheapSkillModel?: string` (default `"haiku"` via `DEFAULT_CHEAP_SKILL_MODEL`; empty string disables).
- Codex artifacts: **command→skill payloads only**; loop/hook payloads never emit for codex. `model:` frontmatter is never written to Codex files.
- Manifest identity is **(name, target)**; entries without `target` mean `claude-code` (tolerant reader, no migration).
- Tests: vitest, no network, no real `claude`. Run from `cli/`: `npm test`, `npm run typecheck`.
- Branch: `spec/codex-and-cost`. Commit after every task.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/types.ts` (modify) | `Assistant`, `Config.targets`, `Config.cheapSkillModel`, `ManifestEntry.target?`, command payload `mechanical?` |
| `cli/src/config.ts` (modify) | `resolveTargets`, `resolveCheapModel`, `DEFAULT_CHEAP_SKILL_MODEL` |
| `cli/src/core/manifest.ts` (modify) | (name, target) keying; `removeEntries` |
| `cli/src/core/validate.ts` (modify) | `mechanical` boolean check |
| `cli/src/core/emit/skill.ts` (modify) | `buildSkillDescription` extracted; `model:` line for mechanical skills |
| `cli/src/core/emit/codex-skill.ts` (create) | `CODEX_SKILLS_DIR`, `emitCodexSkill` |
| `cli/src/core/emit/index.ts` (modify) | `assistant` in `EmitOpts`/`EmitResult` |
| `cli/src/core/apply.ts` (modify) | target fan-out, per-root containment, `writes[]` |
| `cli/src/core/detect.ts` (modify) | `mechanical` briefing |
| `cli/src/commands/apply.ts`, `review.ts`, `remove.ts`, `list.ts` (modify) | resolve targets/cheap model; multi-write logging; per-target remove; target column |
| `cli/src/cli.ts`, `README.md`, `cli/README.md` (modify) | logging, config docs, multi-assistant status wording |

---

### Task X1: Types, config resolution, manifest keyed by (name, target)

**Files:**
- Modify: `cli/src/core/types.ts`, `cli/src/config.ts`, `cli/src/core/manifest.ts`, `cli/src/core/validate.ts`
- Test: `cli/src/config.test.ts` (append), `cli/src/core/manifest.test.ts` (append), `cli/src/core/validate.test.ts` (append)

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `types.ts`: `export type Assistant = "claude-code" | "codex"`; `Config.targets?: Assistant[]`; `Config.cheapSkillModel?: string`; `ManifestEntry.target?: Assistant`; command payload gains `mechanical?: boolean`
  - `config.ts`: `DEFAULT_CHEAP_SKILL_MODEL = "haiku"`; `resolveTargets(c: Config): Assistant[]` (default `["claude-code"]`, throws on unknown values); `resolveCheapModel(c: Config): string | undefined` (`""` → undefined, absent → default)
  - `manifest.ts`: `addEntry` replaces by (name, target); `removeEntries(projectDir, name): Promise<ManifestEntry[]>` (all targets; empty array = not found). The single-entry `removeEntry` is **deleted** — `remove.ts` is its only caller and moves to `removeEntries` in X4.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/config.test.ts`:

```ts
import { resolveTargets, resolveCheapModel, DEFAULT_CHEAP_SKILL_MODEL } from "./config.js";

describe("resolveTargets", () => {
  it("defaults to claude-code", () => expect(resolveTargets({})).toEqual(["claude-code"]));
  it("passes valid lists through", () =>
    expect(resolveTargets({ targets: ["claude-code", "codex"] })).toEqual(["claude-code", "codex"]));
  it("throws on unknown targets (config is user-authored — fail loudly)", () =>
    expect(() => resolveTargets({ targets: ["cursor"] as never })).toThrow(/unknown target/));
  it("throws on an empty list", () =>
    expect(() => resolveTargets({ targets: [] })).toThrow(/at least one/));
});

describe("resolveCheapModel", () => {
  it("defaults to haiku", () => expect(resolveCheapModel({})).toBe(DEFAULT_CHEAP_SKILL_MODEL));
  it("empty string disables", () => expect(resolveCheapModel({ cheapSkillModel: "" })).toBeUndefined());
  it("passes custom values through", () => expect(resolveCheapModel({ cheapSkillModel: "claude-haiku-4-5" })).toBe("claude-haiku-4-5"));
});
```

Append to `cli/src/core/manifest.test.ts`:

```ts
import { removeEntries } from "./manifest.js";

const entry = (name: string, target?: "claude-code" | "codex"): ManifestEntry =>
  ({ name, type: "skill", path: `/p/${name}/${target ?? "cc"}`, createdAt: "2026-07-09", suggestionId: "x", ...(target ? { target } : {}) });

describe("manifest (name, target) keying", () => {
  it("keeps one entry per (name, target) and replaces on re-add", async () => {
    await addEntry(dir, entry("lgtm"));
    await addEntry(dir, entry("lgtm", "codex"));
    await addEntry(dir, entry("lgtm"));                     // replaces the claude-code one only
    expect(await loadManifest(dir)).toHaveLength(2);
  });
  it("treats absent target as claude-code (pre-Spec-10 manifests)", async () => {
    await addEntry(dir, entry("lgtm"));
    await addEntry(dir, { ...entry("lgtm"), target: "claude-code" });
    expect(await loadManifest(dir)).toHaveLength(1);
  });
  it("removeEntries removes every target and returns them", async () => {
    await addEntry(dir, entry("lgtm"));
    await addEntry(dir, entry("lgtm", "codex"));
    const removed = await removeEntries(dir, "lgtm");
    expect(removed).toHaveLength(2);
    expect(await loadManifest(dir)).toHaveLength(0);
  });
  it("removeEntries returns empty for unknown names", async () => {
    expect(await removeEntries(dir, "ghost")).toEqual([]);
  });
});
```

Append to `cli/src/core/validate.test.ts`:

```ts
it("rejects non-boolean mechanical", () => {
  const s = { id: "1", name: "n", title: "t", rationale: "r", confidence: "high",
    payload: { type: "command", commandName: "n", body: "b", mechanical: "yes" } };
  expect(() => validateSuggestion(s)).toThrow(/mechanical/);
});
it("accepts boolean or absent mechanical", () => {
  const base = { id: "1", name: "n", title: "t", rationale: "r", confidence: "high",
    payload: { type: "command", commandName: "n", body: "b" } };
  expect(() => validateSuggestion(base)).not.toThrow();
  expect(() => validateSuggestion({ ...base, payload: { ...base.payload, mechanical: true } })).not.toThrow();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/config.test.ts src/core/manifest.test.ts src/core/validate.test.ts`
Expected: FAIL — `resolveTargets` / `removeEntries` not exported; mechanical unchecked.

- [ ] **Step 3: Implement**

`cli/src/core/types.ts`:

```ts
/** An assistant gradient can emit artifacts for (Spec 10 Decision 2). */
export type Assistant = "claude-code" | "codex";
```

Command payload variant gains `mechanical?: boolean` (alongside Phase A's `triggers?`); `ManifestEntry` gains:

```ts
  /** Absent = claude-code (entries predating multi-assistant). */
  target?: Assistant;
```

`Config` gains:

```ts
  /** Assistants `apply` writes artifacts for. Default ["claude-code"]. */
  targets?: Assistant[];
  /** Model frontmatter for mechanical skills; "" disables. Default "haiku". */
  cheapSkillModel?: string;
```

`cli/src/config.ts`:

```ts
import type { Assistant, Config } from "./core/types.js";

export const DEFAULT_CHEAP_SKILL_MODEL = "haiku";
const ASSISTANTS: ReadonlySet<string> = new Set(["claude-code", "codex"]);

/** Config is user-authored — unknown targets fail loudly, not tolerantly (Spec 10 D2). */
export function resolveTargets(c: Config): Assistant[] {
  const t = c.targets ?? ["claude-code"];
  if (t.length === 0) throw new Error("config targets must list at least one assistant");
  for (const x of t) if (!ASSISTANTS.has(x)) throw new Error(`unknown target: ${x} (use "claude-code" | "codex")`);
  return t;
}

export function resolveCheapModel(c: Config): string | undefined {
  if (c.cheapSkillModel === "") return undefined;
  return c.cheapSkillModel ?? DEFAULT_CHEAP_SKILL_MODEL;
}
```

`cli/src/core/manifest.ts`:

```ts
const keyOf = (name: string, target?: string) => `${name}\u0000${target ?? "claude-code"}`;

export async function addEntry(projectDir: string, e: ManifestEntry): Promise<void> {
  const entries = (await loadManifest(projectDir)).filter(x => keyOf(x.name, x.target) !== keyOf(e.name, e.target));
  entries.push(e);
  await save(projectDir, entries);
}

/** Remove every target's entry for `name`. Returns the removed entries ([] = not found). */
export async function removeEntries(projectDir: string, name: string): Promise<ManifestEntry[]> {
  const entries = await loadManifest(projectDir);
  const found = entries.filter(x => x.name === name);
  if (found.length > 0) await save(projectDir, entries.filter(x => x.name !== name));
  return found;
}
```

Delete `removeEntry` in the same change and update its one caller (`commands/remove.ts`) minimally to compile — full multi-target removal behavior lands in X4:

```ts
const [entry] = await removeEntries(projectDir, name);
if (!entry) return false;
```

`cli/src/core/validate.ts`, in the command branch (next to Phase A's `triggers` check):

```ts
  if (payload.mechanical !== undefined && typeof payload.mechanical !== "boolean") {
    throw new Error("command payload mechanical must be a boolean");
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS (remove tests still green — single-entry behavior is preserved by X1's shim).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/types.ts cli/src/config.ts cli/src/config.test.ts cli/src/core/manifest.ts cli/src/core/manifest.test.ts cli/src/core/validate.ts cli/src/core/validate.test.ts cli/src/commands/remove.ts
git commit -m "feat(core): assistant targets config + (name,target) manifest identity"
```

---

### Task X2: Codex skill emitter + `assistant` dispatch + cheap-model frontmatter

**Files:**
- Create: `cli/src/core/emit/codex-skill.ts`
- Modify: `cli/src/core/emit/skill.ts`, `cli/src/core/emit/index.ts`
- Test: `cli/src/core/emit/emit.test.ts` (append)

**Interfaces:**
- Consumes: A3's `emitSkill`, `sanitizeName`.
- Produces:
  - `emit/skill.ts`: `buildSkillDescription(title: string, triggers?: string[]): string` (exported; A3's inline logic extracted verbatim); `emitSkill(s, opts?: { model?: string })` — emits `model: <JSON string>` in frontmatter **only when** `opts.model` is set **and** `s.payload.mechanical === true`
  - `emit/codex-skill.ts`: `CODEX_SKILLS_DIR = ".agents/skills"`; `emitCodexSkill(s: Suggestion): { path: string; content: string }` — `name` + `description` frontmatter only, body verbatim
  - `emit/index.ts`: `interface EmitOpts { target?: EmitTarget; assistant?: Assistant; cheapModel?: string }`; skill results gain `assistant: Assistant`; `emit(s, { assistant: "codex" })` throws for loop/hook payloads.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/emit/emit.test.ts`:

```ts
import { emitCodexSkill, CODEX_SKILLS_DIR } from "./codex-skill.js";

const mech = { id: "1", name: "fix-push", title: "Fix the push", rationale: "",
  evidence: { count: 3, sessions: 2 }, confidence: "high" as const,
  payload: { type: "command" as const, commandName: "fix-push", body: "Do the fix.",
    triggers: ["gp failed"], mechanical: true } };

describe("emitCodexSkill", () => {
  it("writes under .agents/skills with minimal frontmatter", () => {
    const { path, content } = emitCodexSkill(mech);
    expect(path).toBe(`${CODEX_SKILLS_DIR}/fix-push/SKILL.md`);
    expect(content).toContain('name: "fix-push"');
    expect(content).toContain("Use when the user says things like");
    expect(content).not.toContain("model:");           // never for codex
    expect(content.endsWith("Do the fix.\n")).toBe(true);
  });
});

describe("cheap-model frontmatter", () => {
  it("mechanical + model option → model line", () => {
    const { content } = emitSkill(mech, { model: "haiku" });
    expect(content).toContain('model: "haiku"');
  });
  it("no model without the option, and none for non-mechanical payloads", () => {
    expect(emitSkill(mech).content).not.toContain("model:");
    const plain = { ...mech, payload: { ...mech.payload, mechanical: false } };
    expect(emitSkill(plain, { model: "haiku" }).content).not.toContain("model:");
  });
});

describe("assistant dispatch", () => {
  it("codex assistant routes command payloads to the codex emitter", () => {
    const r = emit(mech, { assistant: "codex" });
    expect(r.kind).toBe("skill");
    if (r.kind === "skill") {
      expect(r.assistant).toBe("codex");
      expect(r.path.startsWith(".agents/")).toBe(true);
    }
  });
  it("claude-code skill results carry their assistant", () => {
    const r = emit(mech, { cheapModel: "haiku" });
    if (r.kind === "skill") {
      expect(r.assistant).toBe("claude-code");
      expect(r.content).toContain('model: "haiku"');
    } else { throw new Error("expected skill"); }
  });
  it("codex + loop/hook payloads throw (apply filters first; emit stays defensive)", () => {
    const loop = { ...mech, payload: { type: "loop" as const, instruction: "x" } };
    expect(() => emit(loop, { assistant: "codex" })).toThrow(/codex/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/emit/emit.test.ts`
Expected: FAIL — `./codex-skill.js` missing; no model line; no assistant field.

- [ ] **Step 3: Implement**

`cli/src/core/emit/skill.ts` — extract the description builder A3 wrote inline, add the gated model line:

```ts
/** Shared by the Claude and Codex skill emitters (Spec 10 Decision 5). */
export function buildSkillDescription(title: string, triggers?: string[]): string {
  const clean = title.replace(/[\r\n]+/g, " ").trim();
  const quoted = (triggers ?? [])
    .map(t => JSON.stringify(t.replace(/[\r\n]+/g, " ").trim()))
    .join(", ");
  return quoted ? `${clean}. Use when the user says things like: ${quoted}.` : clean;
}

export function emitSkill(s: Suggestion, opts: { model?: string } = {}): { path: string; content: string } {
  if (s.payload.type !== "command") throw new Error("emitSkill needs a command payload");
  const name = sanitizeName(s.payload.commandName);
  const description = buildSkillDescription(s.title, s.payload.triggers);
  const model = opts.model && s.payload.mechanical ? `model: ${JSON.stringify(opts.model)}\n` : "";
  const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${model}---\n${s.payload.body}\n`;
  return { path: `.claude/skills/${name}/SKILL.md`, content };
}
```

`cli/src/core/emit/codex-skill.ts`:

```ts
import type { Suggestion } from "../types.js";
import { sanitizeName } from "../security.js";
import { buildSkillDescription } from "./skill.js";

/** Pinned per spec §8; verify against current Codex docs before first use. */
export const CODEX_SKILLS_DIR = ".agents/skills";

/** Codex SKILL.md: minimal frontmatter (name, description), body verbatim,
 * never a model line (Spec 10 Decisions 3, 5, 7). */
export function emitCodexSkill(s: Suggestion): { path: string; content: string } {
  if (s.payload.type !== "command") throw new Error("emitCodexSkill needs a command payload");
  const name = sanitizeName(s.payload.commandName);
  const description = buildSkillDescription(s.title, s.payload.triggers);
  const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${s.payload.body}\n`;
  return { path: `${CODEX_SKILLS_DIR}/${name}/SKILL.md`, content };
}
```

`cli/src/core/emit/index.ts`:

```ts
import type { Assistant, Suggestion } from "../types.js";
import { emitCodexSkill } from "./codex-skill.js";

export interface EmitOpts { target?: EmitTarget; assistant?: Assistant; cheapModel?: string }

export type EmitResult =
  | { kind: "command"; path: string; content: string }
  | { kind: "skill"; path: string; content: string; assistant: Assistant }
  | { kind: "loop"; command: string }
  | { kind: "hook"; settingsPatch: string };

export function emit(s: Suggestion, opts: EmitOpts = {}): EmitResult {
  const assistant = opts.assistant ?? "claude-code";
  if (assistant === "codex" && s.payload.type !== "command") {
    throw new Error("codex target supports command→skill payloads only");
  }
  switch (s.payload.type) {
    case "command":
      if (assistant === "codex") return { kind: "skill", assistant, ...emitCodexSkill(s) };
      return (opts.target ?? "skill") === "command"
        ? { kind: "command", ...emitCommand(s) }
        : { kind: "skill", assistant, ...emitSkill(s, { model: opts.cheapModel }) };
    case "loop": return { kind: "loop", ...emitLoop(s) };
    case "hook": return { kind: "hook", ...emitHook(s) };
  }
}
```

(Phase A's A3 tests constructed skill results without `assistant` — update those assertions in the same change.)

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/emit/skill.ts cli/src/core/emit/codex-skill.ts cli/src/core/emit/index.ts cli/src/core/emit/emit.test.ts
git commit -m "feat(emit): codex skill emitter + assistant dispatch + gated model frontmatter"
```

---

### Task X3: Apply fan-out with per-root containment

**Files:**
- Modify: `cli/src/core/apply.ts`
- Test: `cli/src/core/apply.test.ts` (append)

**Interfaces:**
- Consumes: `emit(s, opts)` from X2, `addEntry` from X1, A4's `applySuggestion` shape.
- Produces:
  - `ApplyResult` gains `writes: { target: Assistant; path: string }[]` and `skippedTargets: Assistant[]`; `written` stays as the first write (existing callers keep working).
  - `applySuggestion(s, projectDir, opts?: { emitTarget?: EmitTarget; targets?: Assistant[]; cheapModel?: string })` — one manifest entry per written target; loop/hook payloads emit once (claude-code) and are skipped for codex.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/apply.test.ts`:

```ts
const mech = { id: "9", name: "fix-push", title: "Fix the push", rationale: "",
  evidence: { count: 3, sessions: 2 }, confidence: "high" as const,
  payload: { type: "command" as const, commandName: "fix-push", body: "b", mechanical: true } };

it("fans a command out to both assistants with per-target manifest entries", async () => {
  const r = await applySuggestion(mech, dir, { targets: ["claude-code", "codex"], cheapModel: "haiku" });
  expect(r.writes.map(w => w.target)).toEqual(["claude-code", "codex"]);
  expect(r.writes[0].path).toContain(join(".claude", "skills", "fix-push"));
  expect(r.writes[1].path).toContain(join(".agents", "skills", "fix-push"));
  const manifest = await loadManifest(dir);
  expect(manifest).toHaveLength(2);
  expect(manifest.find(e => e.target === "codex")?.path).toContain(".agents");
});

it("skips codex for loop payloads and reports it", async () => {
  const loop = { ...mech, id: "8", name: "a-loop", payload: { type: "loop" as const, instruction: "x" } };
  const r = await applySuggestion(loop, dir, { targets: ["claude-code", "codex"] });
  expect(r.skippedTargets).toEqual(["codex"]);
  expect(r.printed).toBeDefined();
  expect(await loadManifest(dir)).toHaveLength(1);   // one loop entry, claude-code only
});

it("defaults to claude-code only (pre-Spec-10 behavior unchanged)", async () => {
  const r = await applySuggestion(mech, dir);
  expect(r.writes).toHaveLength(1);
  expect(r.written).toBe(r.writes[0].path);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/apply.test.ts`
Expected: FAIL — `writes` undefined.

- [ ] **Step 3: Implement** — rework `applySuggestion` (building on A4's shape):

```ts
import type { Assistant } from "./types.js";
import type { EmitTarget, EmitOpts } from "./emit/index.js";

export interface ApplyResult {
  suggestion: Suggestion;
  writes: { target: Assistant; path: string }[];
  skippedTargets: Assistant[];
  written?: string;   // first write — kept for existing call sites
  printed?: string;
}

export async function applySuggestion(
  s: Suggestion,
  projectDir: string,
  opts: { emitTarget?: EmitTarget; targets?: Assistant[]; cheapModel?: string } = {},
): Promise<ApplyResult> {
  const targets = opts.targets ?? ["claude-code"];
  const writes: ApplyResult["writes"] = [];
  const skippedTargets: Assistant[] = [];
  let printed: string | undefined;
  const createdAt = new Date().toISOString().slice(0, 10);

  for (const target of targets) {
    if (target === "codex" && s.payload.type !== "command") { skippedTargets.push(target); continue; }
    const result = emit(s, { target: opts.emitTarget, assistant: target, cheapModel: opts.cheapModel });
    let entryPath = "";
    let type: ArtifactType;
    if (result.kind === "command" || result.kind === "skill") {
      const root = target === "codex" ? ".agents" : ".claude";
      const abs = join(projectDir, result.path);
      assertInside(join(projectDir, root), abs);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, result.content);
      writes.push({ target, path: abs });
      entryPath = abs;
      type = result.kind;
    } else if (result.kind === "loop") {
      printed = result.command;
      type = "loop";
    } else {
      printed = result.settingsPatch;
      type = "hook";
    }
    await addEntry(projectDir, {
      name: s.name, type, path: entryPath, createdAt, suggestionId: s.id,
      ...(target !== "claude-code" ? { target } : {}),
    });
  }
  return { suggestion: s, writes, skippedTargets, written: writes[0]?.path, printed };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS — A4's existing apply tests keep passing (`written` semantics preserved for the default target list).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/apply.ts cli/src/core/apply.test.ts
git commit -m "feat(apply): fan out to configured assistants; per-target manifest entries"
```

---

### Task X4: Command wiring — targets resolution, remove-all-targets, list column, detect briefing, review preview, docs

**Files:**
- Modify: `cli/src/commands/apply.ts`, `cli/src/commands/review.ts`, `cli/src/commands/remove.ts`, `cli/src/commands/list.ts`, `cli/src/core/detect.ts`, `cli/src/cli.ts`, `README.md`, `cli/README.md`
- Test: `cli/src/commands/manage.test.ts` (append), `cli/src/core/detect.test.ts` (append)

**Interfaces:**
- Consumes: `resolveTargets`, `resolveCheapModel`, `removeEntries`, `ApplyResult.writes`.
- Produces:
  - `applyByIds` and `review` resolve `{ targets, cheapModel, emitTarget }` from config once and pass them through.
  - `remove` unlinks **every** target's file (and A4's emptied-skill-dir cleanup per entry, `.agents` included).
  - `list` renders a `target` column value only for non-default targets.
  - `detect` system prompt asks for `mechanical` with the canonical yes/no examples (spec §4).
  - `readlinePrompter(cheapModel?: string)` prints `emits with model: <m>` for mechanical command payloads.
  - Docs: config keys documented; README status wording updated from "multi-assistant: deferred" to Stage-1-shipped + pointer to this spec.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/commands/manage.test.ts`:

```ts
it("remove deletes artifacts for every target", async () => {
  const s = { id: "9", name: "fix-push", title: "t", rationale: "", confidence: "high" as const,
    evidence: { count: 3, sessions: 2 },
    payload: { type: "command" as const, commandName: "fix-push", body: "b" } };
  await applySuggestion(s, dir, { targets: ["claude-code", "codex"] });
  expect(await remove(dir, "fix-push")).toBe(true);
  await expect(stat(join(dir, ".claude", "skills", "fix-push"))).rejects.toThrow();
  await expect(stat(join(dir, ".agents", "skills", "fix-push"))).rejects.toThrow();
  expect(await loadManifest(dir)).toHaveLength(0);
});
```

Append to `cli/src/core/detect.test.ts`:

```ts
it("asks the model for the mechanical flag with canonical examples", () => {
  const { system } = buildDetectPrompt([]);
  expect(system).toContain("mechanical");
  expect(system).toContain("zero judgment");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/manage.test.ts src/core/detect.test.ts`
Expected: FAIL — codex file survives removal; prompt lacks mechanical wording.

- [ ] **Step 3: Implement**

`cli/src/commands/remove.ts` — replace the single-entry flow with a loop over `removeEntries` (keeping A4's emptied-dir cleanup per entry; it works for both roots since `entry.path` is absolute):

```ts
import { removeEntries } from "../core/manifest.js";

export async function remove(projectDir: string, name: string): Promise<boolean> {
  const entries = await removeEntries(projectDir, name);
  if (entries.length === 0) return false;
  for (const entry of entries) {
    if (!entry.path) continue;
    await unlink(entry.path).catch(() => { /* already gone */ });
    if (entry.type === "skill") {
      try { await rmdir(dirname(entry.path)); } catch { /* not empty — leave it */ }
    }
  }
  return true;
}
```

`cli/src/commands/apply.ts` and `cli/src/commands/review.ts` — extend the config resolution A4 added:

```ts
const config = await loadConfig();
const emitTarget = config.emitTarget ?? "skill";
const targets = resolveTargets(config);
const cheapModel = resolveCheapModel(config);
// ...applySuggestion(s, projectDir, { emitTarget, targets, cheapModel })
```

`cli/src/commands/review.ts` — `readlinePrompter(cheapModel?: string)`; inside the prompter, after the title line:

```ts
    if (s.payload.type === "command" && s.payload.mechanical && cheapModel) {
      process.stdout.write(`  emits with model: ${cheapModel} (mechanical workflow)\n`);
    }
```

`cli/src/commands/list.ts` — include `e.target` in the row when set (same muted styling as the path column).

`cli/src/core/detect.ts` — append to the `system` string:

```ts
"For command payloads also set mechanical: true when executing the workflow needs zero judgment " +
"calls (a fixed command sequence — e.g. retarget a git push remote and push again); leave it " +
"false/absent when steps need judgment (e.g. 'review the spec then write the plan'). " +
```

`cli/src/cli.ts` — apply/review result logging iterates `a.writes` (falling back to `printed`):

```ts
for (const a of applied) {
  for (const w of a.writes) log(`${c.ok("wrote")} ${c.muted(w.path)}${w.target !== "claude-code" ? c.dim(` [${w.target}]`) : ""}`);
  if (a.printed) log(`  ${c.dim("run:")} ${a.printed}`);
}
```

Review case resolves config once and passes the model through:

```ts
      case "review": {
        const cfg = await loadConfig();
        const applied = await review(projectDir, readlinePrompter(resolveCheapModel(cfg)));
        // ...rest of the case unchanged
```

(If Spec 9's clarifier has landed by then, keep its `readlineClarifier()` third argument — the two changes compose; whichever lands second reconciles this case.)

Docs (same commit): `cli/README.md` config section gains `targets` and `cheapSkillModel` rows with defaults; `README.md` — replace the multi-assistant "deferred" wording (Spec 1 §9 echo in the Status section) with one line: skills can also emit for Codex (`targets` in config, Spec 10 Stage 1); Stage 2 (mining Codex history) tracked in the spec.

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/apply.ts cli/src/commands/review.ts cli/src/commands/remove.ts cli/src/commands/list.ts cli/src/core/detect.ts cli/src/core/detect.test.ts cli/src/commands/manage.test.ts cli/src/cli.ts README.md cli/README.md
git commit -m "feat(cli): multi-target apply/remove/list, mechanical briefing, docs"
```
