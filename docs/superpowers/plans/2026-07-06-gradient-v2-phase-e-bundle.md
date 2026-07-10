# gradient v2 Phase E — `gradient bundle` (Team Distribution) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `gradient bundle <name>` packages manifest-tracked, approved artifacts into a Claude Code plugin directory (`.gradient/bundle/<name>/`) with `plugin.json`, `skills/`, optional `commands/`, `rules/`, and (opt-in) `hooks/hooks.json` — evidence counts stripped, publishing left to the user. Spec: `docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md` §7.

**Architecture:** `core/bundle.ts` reads the manifest, copies artifact files into the plugin layout, synthesizes `plugin.json` and a provenance README, and (with `--with-hooks`) reconstructs `hooks/hooks.json` from the applied hook suggestions still present in `suggestions.json`. `commands/bundle.ts` + CLI wire-up print the tree and a marketplace snippet.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

- **Depends on Phase A** (skill artifacts); rules (Phase C) are bundled when present, tolerated when absent. Branch: `spec/v2-phase-e`.
- **Only manifest entries ship.** Unapproved `suggestions.json` content must never leak into a bundle (spec §7). Evidence counts (personal telemetry) appear nowhere in bundle output — no "seen N×" strings, no `suggestions.json` copy.
- **Rules caveat:** Claude Code plugins have no `rules/` auto-load; bundled rules land in `rules/` with a README instruction to copy them into a project's `.claude/rules/`. Recorded in the bundle README, not silently.
- **Hooks are opt-in (`--with-hooks`)** and only ever `gradient <subcommand>` commands; the README states teammates need `gradient` installed for them.
- All bundle writes go through `assertInside(join(projectDir, ".gradient"), …)`.
- **Verified against current docs (2026-07-09):** `plugin.json` uses `name`, `description`, and `version`; root-level `skills/`, `commands/`, and `hooks/hooks.json` are auto-discovered. A marketplace catalog requires top-level `owner` and plugin-entry `name` + `source`.
- Tests: vitest, temp dirs, no network. Run from `cli/`: `npm test`, `npm run typecheck`.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/bundle.ts` (create) | manifest → plugin layout; plugin.json; README; hooks.json |
| `cli/src/commands/bundle.ts` (create) | orchestration + result shaping for the CLI |
| `cli/src/cli.ts` (modify) | `bundle` dispatch, `--with-hooks` flag, HELP |
| `README.md` (modify) | team distribution section |

---

### Task E1: Bundle core — layout, plugin.json, README, artifact copy

**Files:**
- Create: `cli/src/core/bundle.ts`
- Test: `cli/src/core/bundle.test.ts` (create)

**Interfaces:**
- Consumes: `loadManifest`, `gradientDir` (`core/manifest.ts`), `sanitizeName`, `assertInside` (`core/security.ts`).
- Produces (E2/E3 rely on these exact names):
  - `interface BundleResult { dir: string; files: string[]; skipped: string[] }`
  - `buildBundle(projectDir: string, name: string, opts?: { withHooks?: boolean }): Promise<BundleResult>`
  - Layout under `<projectDir>/.gradient/bundle/<sanitized name>/`:
    - `.claude-plugin/plugin.json` → `{ "name": <sanitized>, "description": "Workflows mined from real usage by gradient", "version": "0.1.0" }`
    - `skills/<artifact name>/SKILL.md` for `type: "skill"` entries (file copied verbatim)
    - `commands/<artifact name>.md` for `type: "command"` entries
    - `rules/<basename>` for `type: "rule"` entries with a file path
    - `README.md` — provenance + rules caveat + hooks caveat (E2)
  - Entries with `path: ""` (loops, printed hooks) and entries whose file is unreadable → `skipped` (hooks get picked up by E2's suggestion lookup instead).

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/bundle.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundle } from "./bundle.js";
import { addEntry } from "./manifest.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "grad-bun-")); });

async function seedSkill(name: string): Promise<void> {
  const p = join(dir, ".claude", "skills", name, "SKILL.md");
  await mkdir(join(dir, ".claude", "skills", name), { recursive: true });
  await writeFile(p, `---\nname: ${JSON.stringify(name)}\ndescription: "d"\n---\nbody\n`);
  await addEntry(dir, { name, type: "skill", path: p, createdAt: "2026-07-01", suggestionId: `sig-${name}` });
}

describe("buildBundle", () => {
  it("copies manifest skills into the plugin layout with plugin.json and README", async () => {
    await seedSkill("ship");
    const r = await buildBundle(dir, "Team Toolkit!");
    expect(r.dir).toContain(join(".gradient", "bundle", "team-toolkit"));
    const manifest = JSON.parse(await readFile(join(r.dir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest).toEqual({ name: "team-toolkit", description: "Workflows mined from real usage by gradient", version: "0.1.0" });
    expect(await readFile(join(r.dir, "skills", "ship", "SKILL.md"), "utf8")).toContain("body");
    expect(await readFile(join(r.dir, "README.md"), "utf8")).toContain("gradient");
  });
  it("skips pathless and unreadable entries; never copies suggestions.json or evidence", async () => {
    await seedSkill("ship");
    await addEntry(dir, { name: "a-loop", type: "loop", path: "", createdAt: "2026-07-01", suggestionId: "s2" });
    await addEntry(dir, { name: "ghost", type: "skill", path: join(dir, ".claude", "skills", "ghost", "SKILL.md"), createdAt: "2026-07-01", suggestionId: "s3" });
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), "[]");
    const r = await buildBundle(dir, "kit");
    expect(r.skipped.sort()).toEqual(["a-loop", "ghost"]);
    const names = await readdir(r.dir);
    expect(names).not.toContain("suggestions.json");
    const readme = await readFile(join(r.dir, "README.md"), "utf8");
    expect(readme).not.toMatch(/seen \d+×/);
  });
  it("bundles nothing from an empty manifest but still writes a valid shell", async () => {
    const r = await buildBundle(dir, "kit");
    expect(r.files.some(f => f.endsWith("plugin.json"))).toBe(true);
    expect(r.skipped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/bundle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `cli/src/core/bundle.ts`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { loadManifest, gradientDir } from "./manifest.js";
import { assertInside, sanitizeName } from "./security.js";

export interface BundleResult { dir: string; files: string[]; skipped: string[] }

const BUNDLE_DESCRIPTION = "Workflows mined from real usage by gradient";

async function put(root: string, rel: string, content: string, files: string[]): Promise<void> {
  const abs = join(root, rel);
  assertInside(root, abs);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
  files.push(abs);
}

function readme(name: string, hasRules: boolean, hasHooks: boolean): string {
  return [
    `# ${name}`,
    "",
    `Generated by [gradient](https://gradient.md) from approved, usage-mined artifacts.`,
    `Evidence counts are personal telemetry and are deliberately not included.`,
    "",
    `Install for a project: \`claude --plugin-dir <path-to-this-directory>\` or host in a marketplace repo.`,
    ...(hasRules ? ["", "`rules/`: Claude Code plugins do not auto-load rules — copy them into a project's `.claude/rules/`."] : []),
    ...(hasHooks ? ["", "`hooks/hooks.json`: these hooks call `gradient` subcommands — teammates need gradient installed (`npx gradient`)."] : []),
    "",
  ].join("\n");
}

export async function buildBundle(
  projectDir: string,
  name: string,
  opts: { withHooks?: boolean } = {},
): Promise<BundleResult> {
  const safe = sanitizeName(name);
  const root = join(gradientDir(projectDir), "bundle", safe);
  assertInside(join(projectDir, ".gradient"), root);
  const files: string[] = [];
  const skipped: string[] = [];
  let hasRules = false;

  for (const e of await loadManifest(projectDir)) {
    if (!e.path) { if (e.type !== "hook") skipped.push(e.name); continue; } // hooks handled by suggestion lookup (E2)
    let content: string;
    try { content = await readFile(e.path, "utf8"); } catch { skipped.push(e.name); continue; }
    if (e.type === "skill") await put(root, join("skills", e.name, "SKILL.md"), content, files);
    else if (e.type === "command") await put(root, join("commands", `${e.name}.md`), content, files);
    else if (e.type === "rule") { hasRules = true; await put(root, join("rules", basename(e.path)), content, files); }
    else skipped.push(e.name);
  }

  const hasHooks = false; // E2 flips this when --with-hooks emits hooks.json
  await put(root, join(".claude-plugin", "plugin.json"),
    JSON.stringify({ name: safe, description: BUNDLE_DESCRIPTION, version: "0.1.0" }, null, 2) + "\n", files);
  await put(root, "README.md", readme(safe, hasRules, hasHooks), files);
  return { dir: root, files, skipped };
}
```

(Note for E2: `hasHooks` is a placeholder wired properly when hook emission lands; the README builder already accepts it.)

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/bundle.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/bundle.ts cli/src/core/bundle.test.ts
git commit -m "feat(core): gradient bundle layout — manifest artifacts into a plugin dir"
```

---

### Task E2: `--with-hooks` — hooks.json from applied hook suggestions

**Files:**
- Modify: `cli/src/core/bundle.ts`
- Test: `cli/src/core/bundle.test.ts` (append)

**Interfaces:**
- Consumes: `loadSuggestions` (`commands/apply.ts` — import the function, it has no CLI coupling), manifest `suggestionId` linkage, `KNOWN_SUBCOMMANDS` (`core/validate.ts`).
- Produces: with `opts.withHooks`, manifest entries of `type: "hook"` are resolved via `suggestionId` against `suggestions.json`; resolvable hook payloads with a known subcommand aggregate into `hooks/hooks.json`:
  `{ "hooks": { "<event>": [ { "hooks": [{ "type": "command", "command": "gradient <subcommand>" }] } ] } }`.
  Unresolvable or unknown-subcommand hooks → `skipped`. Without the flag, hook entries are silently ignored (not even skipped-listed — they're not expected in a skills bundle).

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/bundle.test.ts`:

```ts
it("emits hooks.json for resolvable hook suggestions when --with-hooks", async () => {
  await mkdir(join(dir, ".gradient"), { recursive: true });
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([{
    id: "h1", name: "pre-compact-checkpoint", title: "t", rationale: "", confidence: "high",
    evidence: { count: 100, sessions: 90 },
    payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "d" },
  }]));
  await addEntry(dir, { name: "pre-compact-checkpoint", type: "hook", path: "", createdAt: "2026-07-01", suggestionId: "h1" });
  const r = await buildBundle(dir, "kit", { withHooks: true });
  const hooks = JSON.parse(await readFile(join(r.dir, "hooks", "hooks.json"), "utf8"));
  expect(hooks.hooks.PreCompact[0].hooks[0]).toEqual({ type: "command", command: "gradient checkpoint" });
  expect(await readFile(join(r.dir, "README.md"), "utf8")).toContain("need gradient installed");
});

it("skips unresolvable hook entries under --with-hooks and stays silent without it", async () => {
  await addEntry(dir, { name: "mystery-hook", type: "hook", path: "", createdAt: "2026-07-01", suggestionId: "gone" });
  expect((await buildBundle(dir, "kit", { withHooks: true })).skipped).toContain("mystery-hook");
  expect((await buildBundle(dir, "kit2")).skipped).not.toContain("mystery-hook");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/bundle.test.ts`
Expected: FAIL — no hooks.json written.

- [ ] **Step 3: Implement** — in `cli/src/core/bundle.ts`, replace the hook-handling and `hasHooks` placeholder:

```ts
import { loadSuggestions } from "../commands/apply.js";
import { KNOWN_SUBCOMMANDS } from "./validate.js";

// inside buildBundle, before writing plugin.json:
let hasHooks = false;
if (opts.withHooks) {
  const suggestions = await loadSuggestions(projectDir);
  const byId = new Map(suggestions.map(s => [s.id, s]));
  const hookEvents: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> = {};
  for (const e of await loadManifest(projectDir)) {
    if (e.type !== "hook") continue;
    const s = byId.get(e.suggestionId);
    if (!s || s.payload.type !== "hook" || !KNOWN_SUBCOMMANDS.has(s.payload.subcommand)) { skipped.push(e.name); continue; }
    (hookEvents[s.payload.event] ??= []).push({ hooks: [{ type: "command", command: `gradient ${s.payload.subcommand}` }] });
  }
  if (Object.keys(hookEvents).length > 0) {
    hasHooks = true;
    await put(root, join("hooks", "hooks.json"), JSON.stringify({ hooks: hookEvents }, null, 2) + "\n", files);
  }
}
```

and in the main manifest loop, change the pathless-entry branch so hook entries are only `skipped` when `opts.withHooks` resolution fails (i.e. remove hooks from that branch entirely — they're fully handled above; loops remain `skipped`).

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/bundle.test.ts && npm run typecheck`
Expected: PASS (note the double `loadManifest` call is fine — or hoist it to a single `entries` variable while you're in the function; keep behavior identical).

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/bundle.ts cli/src/core/bundle.test.ts
git commit -m "feat(bundle): opt-in hooks.json from applied gradient hook suggestions"
```

---

### Task E3: CLI wiring + marketplace snippet + docs

**Files:**
- Create: `cli/src/commands/bundle.ts`
- Test: `cli/src/cli.test.ts` (append)
- Modify: `cli/src/cli.ts`, `README.md`

**Interfaces:**
- Consumes: `buildBundle`.
- Produces:
  - `commands/bundle.ts`: `bundleCommand(projectDir: string, name: string, opts: { withHooks?: boolean }): Promise<BundleResult>` (thin passthrough — exists so the CLI stays declarative and tests can stub it).
  - CLI: `gradient bundle <name> [--with-hooks]` — errors with exit 2 when `<name>` is missing; on success prints each file (relative to the bundle dir), the skipped list, a `claude --plugin-dir` try-it line, and the marketplace snippet labeled `verify against current plugin docs`:

    ```json
    { "name": "<name>", "plugins": [{ "source": "./<name>" }] }
    ```

  - HELP line: `gradient bundle <name> [--with-hooks]  package approved artifacts as a plugin`.

- [ ] **Step 1: Write the failing test** — append to `cli/src/cli.test.ts` (reuse its `main(argv, { log })` capture pattern):

```ts
it("bundle requires a name", async () => {
  const logs: string[] = [];
  const code = await main(["bundle"], { log: m => logs.push(m) });
  expect(code).toBe(2);
  expect(logs.join("\n")).toContain("bundle needs a name");
});

it("HELP mentions bundle", async () => {
  const logs: string[] = [];
  await main([], { log: m => logs.push(m) });
  expect(logs.join("\n")).toContain("gradient bundle");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`cli/src/commands/bundle.ts`:

```ts
import { buildBundle, type BundleResult } from "../core/bundle.js";

export async function bundleCommand(
  projectDir: string, name: string, opts: { withHooks?: boolean } = {},
): Promise<BundleResult> {
  return buildBundle(projectDir, name, opts);
}
```

`cli/src/cli.ts` — add `"with-hooks": { type: "boolean" }` to `parseCliArgs` options, the HELP line, and:

```ts
case "bundle": {
  const name = positionals[0];
  if (!name) { log(c.coral("bundle needs a name: gradient bundle <name>")); return 2; }
  const r = await bundleCommand(projectDir, name, { withHooks: !!flags["with-hooks"] });
  log(`${c.ok("bundle written")} ${c.muted(r.dir)}`);
  for (const f of r.files) log(`  ${c.dim(f.slice(r.dir.length + 1))}`);
  for (const s of r.skipped) log(c.muted(`  skipped ${s} (no file or unresolvable)`));
  log(`\n${c.dim("try it:")} claude --plugin-dir ${r.dir}`);
  log(c.dim("marketplace snippet (verify against current plugin docs):"));
  log(JSON.stringify({ name: positionals[0], plugins: [{ source: `./${positionals[0]}` }] }, null, 2));
  return 0;
}
```

`README.md`: "Share with your team" section — approve → `gradient bundle team-kit --with-hooks` → push the folder to a repo → teammates `claude --plugin-dir` or marketplace install. Explicitly note: no evidence counts ship, and nothing unapproved ships.

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/bundle.ts cli/src/cli.ts cli/src/cli.test.ts README.md
git commit -m "feat(cli): gradient bundle — package approved artifacts for the team"
```

---

## Execution notes (2026-07-09)

- **E1 input trust boundary:** the plan constrained bundle writes but trusted
  manifest source paths. The implementation resolves each source through
  `realpath` and requires it to remain inside the project's `.claude/`; a
  tampered manifest cannot package an arbitrary local file.
- **E1 clean projection:** every build removes and recreates its target bundle.
  Removed artifacts and a previous opt-in `hooks.json` therefore cannot linger
  in a later skills-only build.
- **E2 hook validation:** hook reconstruction reuses `emitHook`, the same
  applied-artifact trust boundary, so tampered lifecycle events or unknown
  subcommands are skipped. Duplicate event/command pairs are collapsed.
- **E3 marketplace schema:** the planned snippet omitted the required
  marketplace `owner` and plugin-entry `name`. The shipped catalog includes
  `name`, `owner`, `description`, and a plugin entry with `name`, relative
  `source`, and description.
- **Forward-compatible cache reader:** the final cross-phase audit found
  `suggestions.json` was still cast directly. Every reader now validates entries
  individually, logs invalid future payloads in user-facing commands, and keeps
  processing valid entries.
- **Current-doc validation:** Claude Code 2.1.206 validates both the generated
  plugin and marketplace. The plugin's only warning is optional author
  attribution; no false author is synthesized. The catalog validates cleanly
  once its optional description is included.
- **Dogfood:** approved skill, rule, hook, and loop suggestions were applied in
  a clean project, then bundled with hooks. The skill, rule, and hook landed;
  the pathless loop was reported as skipped. A cache-only unapproved suggestion
  and distinctive evidence counts were absent from every bundle file.
- **Validation:** 440 tests pass; typecheck, build, package dry-run, plugin
  validation, marketplace validation, and privacy leak scan are clean.
