# gradient — Claude Code Plugin Distribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package gradient itself as a Claude Code plugin — hook-free manifest, committed single-file CLI bundle, four skills, and a repo-as-marketplace — so `/plugin install gradient` becomes the recommended onboarding. Spec: `docs/superpowers/specs/2026-07-06-gradient-plugin-design.md`.

**Architecture:** A new top-level `plugin/` directory holds the manifest, four SKILL.md files, and `bin/gradient.mjs` (an esbuild bundle of `cli/src/cli.ts`, committed because marketplace installs pull from git). A root `.claude-plugin/marketplace.json` makes the GitHub repo itself addable as a marketplace. The only CLI change is `gradient review --json` (non-interactive suggestion listing for the review skill). Tests live in `cli/` with the existing vitest setup and reach up into `plugin/` by path.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, esbuild (new **devDependency**, pinned). Zero new runtime dependencies.

## Global Constraints

- **Inert on install (spec §2 #1/#2):** `plugin/` must never contain `hooks/`, `.mcp.json`, `settings.json`, `agents/`, or `monitors/`. A test enforces this.
- **Bundle filename is `plugin/bin/gradient.mjs`** (`.mjs`, not `.js` — `plugin/` has no `package.json`, so a `.js` ESM bundle would be executed as CJS and crash).
- Skills invoke the CLI as `node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" …` — never a PATH `gradient`, never a fallback.
- `cli/package.json` is the single version source; `build:plugin` copies it into `plugin/.claude-plugin/plugin.json`; a test asserts equality (stale bundle ⇒ red).
- The autopilot skill has `disable-model-invocation: true`; scan/review/stats must NOT.
- Verify at execution time against current docs: `${CLAUDE_PLUGIN_ROOT}` expansion in skill bodies, and the exact `marketplace.json` schema (spec §11). Adjust field names if docs disagree; the tests below then follow.
- Known limitation (documented, not fixed): `init` run from the bundle cannot read `src/skill/SKILL.md` (bundle-relative path). Plugin users never need `init`; `plugin/README.md` says so.
- Tests: from `cli/`: `npm test`, `npm run typecheck`. No network, no real `claude`.
- Branch: `spec/plugin`. Commit after every task.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/commands/review.ts` (modify) | `reviewJson(projectDir)` — cached suggestions as JSON |
| `cli/src/cli.ts` (modify) | `--json` flag, review dispatch, HELP line |
| `plugin/.claude-plugin/plugin.json` (create) | plugin manifest (version synced from cli) |
| `.claude-plugin/marketplace.json` (create) | repo-as-marketplace, points at `./plugin` |
| `plugin/README.md` (create) | what installs, what does NOT run |
| `plugin/bin/gradient.mjs` (generated, committed) | esbuild bundle of the CLI |
| `cli/scripts/build-plugin.mjs` (create) | bundle + version sync |
| `plugin/skills/{scan,review,stats,autopilot}/SKILL.md` (create) | the four skills |
| `cli/src/plugin.test.ts` (create) | inert guard, manifest, version sync, bundle smoke, skill frontmatter |
| `README.md`, `cli/README.md`, `cli/src/skill/SKILL.md` (modify) | docs + wording pass |

---

### Task P1: `gradient review --json`

**Files:**
- Modify: `cli/src/commands/review.ts`
- Modify: `cli/src/cli.ts`
- Test: `cli/src/commands/review.test.ts` (append)

**Interfaces:**
- Consumes: `loadSuggestions(projectDir)` from `./apply.js` (already imported by review.ts).
- Produces: `reviewJson(projectDir: string): Promise<string>` — pretty-printed JSON array of cached suggestions; `"[]"` when the cache is missing/unreadable. Task P4's review skill relies on this exact command: `gradient review --json`.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/commands/review.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewJson } from "./review.js";

const SUGGESTION = {
  id: "abc123def4", name: "fix-push", title: "Fix push", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "high",
  payload: { type: "command", commandName: "fix-push", body: "do the thing" },
};

describe("reviewJson", () => {
  it("prints the cached suggestions as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([SUGGESTION]));
    const out = JSON.parse(await reviewJson(dir));
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("abc123def4");
    expect(out[0].payload.type).toBe("command");
  });
  it("prints [] when no cache exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    expect(JSON.parse(await reviewJson(dir))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/review.test.ts`
Expected: FAIL — `reviewJson` is not exported.

- [ ] **Step 3: Implement** — in `cli/src/commands/review.ts` add:

```ts
/** Non-interactive listing for tooling (the plugin's review skill). */
export async function reviewJson(projectDir: string): Promise<string> {
  try {
    return JSON.stringify(await loadSuggestions(projectDir), null, 2);
  } catch {
    return "[]";
  }
}
```

If `loadSuggestions` already returns `[]` for a missing cache, keep the try/catch anyway — the contract is "never throw, never exit non-zero".

- [ ] **Step 4: Wire the flag** — in `cli/src/cli.ts`:
  - `parseCliArgs` options gain `json: { type: "boolean" },`
  - import `reviewJson` alongside `review, readlinePrompter`
  - the `case "review":` becomes:

```ts
case "review": {
  if (flags.json) {
    log(await reviewJson(projectDir));
    return 0;
  }
  const applied = await review(projectDir, readlinePrompter());
  log(`\n${c.ok(`applied ${applied.length} suggestion(s).`)}`);
  for (const a of applied) {
    if (a.printed) log(`  ${c.dim("run:")} ${a.printed}`);
  }
  return 0;
}
```

  - HELP line becomes: `  gradient review [--json]      approve cached suggestions (--json: print them, no prompts)`

- [ ] **Step 5: Run tests + typecheck**

Run: `cd cli && npx vitest run src/commands/review.test.ts src/cli.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/review.ts cli/src/cli.ts cli/src/commands/review.test.ts
git commit -m "feat(cli): gradient review --json for non-interactive tooling"
```

---

### Task P2: Plugin scaffold — manifest, marketplace, README, inert guard

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Create: `plugin/README.md`
- Test: `cli/src/plugin.test.ts` (create)

**Interfaces:**
- Produces: `plugin/` layout and the shared test-path helper used by P3/P4 tests: `repoRoot` / `pluginDir` consts in `cli/src/plugin.test.ts`.

- [ ] **Step 1: Write the failing tests** — create `cli/src/plugin.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const pluginDir = join(repoRoot, "plugin");

describe("plugin is inert on install (spec §2 #1)", () => {
  it("ships no hooks, MCP servers, agents, monitors, or default settings", () => {
    for (const banned of ["hooks", ".mcp.json", "settings.json", "agents", "monitors"]) {
      expect(existsSync(join(pluginDir, banned))).toBe(false);
    }
  });
});

describe("plugin manifest", () => {
  it("is valid and named gradient", () => {
    const m = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(m.name).toBe("gradient");
    expect(typeof m.description).toBe("string");
    expect(typeof m.version).toBe("string");
  });
});

describe("marketplace", () => {
  it("points at ./plugin", () => {
    const m = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(m.plugins?.[0]?.source).toBe("./plugin");
    expect(m.plugins?.[0]?.name).toBe("gradient");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/plugin.test.ts`
Expected: FAIL — plugin.json does not exist.

- [ ] **Step 3: Create `plugin/.claude-plugin/plugin.json`:**

```json
{
  "name": "gradient",
  "description": "Mine your own Claude Code history for repeated workflows and turn them into skills, loops, and hooks. Read-only scan, approve in review, reversible apply — nothing runs without you turning it on.",
  "version": "0.1.0",
  "author": { "name": "ylambda" },
  "homepage": "https://gradient.md"
}
```

- [ ] **Step 4: Create `.claude-plugin/marketplace.json`** (verify schema against current docs first — Global Constraints):

```json
{
  "name": "gradient",
  "owner": { "name": "ylambda" },
  "plugins": [
    {
      "name": "gradient",
      "source": "./plugin",
      "description": "Turn the prompts you keep retyping into Claude Code automations, mined from your own history."
    }
  ]
}
```

- [ ] **Step 5: Create `plugin/README.md`:**

```markdown
# gradient — Claude Code plugin

Installs the gradient CLI (bundled, no npm needed) and four skills:
`/gradient:scan`, `/gradient:review`, `/gradient:stats`, `/gradient:autopilot`.

**Installing this plugin runs nothing.** No hooks, no MCP servers, no settings
changes. Every automation gradient can set up (autopilot, session-start scans)
stays opt-in via its own command and is reversible.

Do not also run `gradient init --skill` (the npx flow's user-level skill) —
you'd get duplicate skills. Plugin users never need `init`: the bundled CLI
uses your existing `claude` auth by default.
```

- [ ] **Step 6: Run tests**

Run: `cd cli && npx vitest run src/plugin.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add plugin/ .claude-plugin/ cli/src/plugin.test.ts
git commit -m "feat(plugin): scaffold — manifest, marketplace, README, inert-on-install guard"
```

---

### Task P3: `build:plugin` — committed bundle + version sync

**Files:**
- Create: `cli/scripts/build-plugin.mjs`
- Modify: `cli/package.json` (script + esbuild devDependency)
- Create (generated): `plugin/bin/gradient.mjs`
- Test: `cli/src/plugin.test.ts` (append)

**Interfaces:**
- Consumes: `cli/src/cli.ts` entry (unchanged), `repoRoot`/`pluginDir` from P2's test file.
- Produces: `plugin/bin/gradient.mjs` — the exact path P4's skill bodies invoke; `npm run build:plugin`.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/plugin.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { VERSION } from "./version.js";

describe("plugin bundle", () => {
  it("version in plugin.json matches cli/package.json (stale bundle guard)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "cli", "package.json"), "utf8"));
    const m = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(m.version).toBe(pkg.version);
  });
  it("bundled bin runs offline and prints the banner", () => {
    const bin = join(pluginDir, "bin", "gradient.mjs");
    expect(existsSync(bin)).toBe(true);
    const r = spawnSync(process.execPath, [bin], { encoding: "utf8", timeout: 15000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(VERSION);   // banner includes the version
    expect(r.stdout).toContain("gradient scan");  // HELP text
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/plugin.test.ts`
Expected: FAIL — `plugin/bin/gradient.mjs` does not exist. (The version test passes already — both read `0.1.0`.)

- [ ] **Step 3: Add esbuild + script** — in `cli/package.json`: add to `devDependencies`: `"esbuild": "0.25.5"` (pin exact; bump deliberately). Add to `scripts`: `"build:plugin": "node scripts/build-plugin.mjs"`. Then `cd cli && npm install`.

- [ ] **Step 4: Create `cli/scripts/build-plugin.mjs`:**

```js
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(cliDir, "..", "plugin");
const outfile = join(pluginDir, "bin", "gradient.mjs");

await build({
  entryPoints: [join(cliDir, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false, // the committed bundle stays diff-reviewable
  banner: { js: "#!/usr/bin/env node" },
});

const pkg = JSON.parse(await readFile(join(cliDir, "package.json"), "utf8"));
const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = pkg.version;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`plugin bundle → ${outfile} (v${pkg.version})`);
```

- [ ] **Step 5: Build and verify**

Run: `cd cli && npm run build:plugin && npx vitest run src/plugin.test.ts`
Expected: bundle written; all plugin tests PASS. Also verify by hand: `node ../plugin/bin/gradient.mjs` prints banner + help, exit 0.

- [ ] **Step 6: Commit (bundle included — it is a distribution artifact)**

```bash
git add cli/package.json cli/package-lock.json cli/scripts/build-plugin.mjs plugin/bin/gradient.mjs plugin/.claude-plugin/plugin.json cli/src/plugin.test.ts
git commit -m "feat(plugin): build:plugin bundles the CLI into plugin/bin + version sync"
```

---

### Task P4: The four skills

**Files:**
- Create: `plugin/skills/scan/SKILL.md`, `plugin/skills/review/SKILL.md`, `plugin/skills/stats/SKILL.md`, `plugin/skills/autopilot/SKILL.md`
- Test: `cli/src/plugin.test.ts` (append)

**Interfaces:**
- Consumes: `node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs"` (P3), `review --json` (P1).

- [ ] **Step 1: Write the failing tests** — append to `cli/src/plugin.test.ts`:

```ts
import { readdirSync } from "node:fs";

function frontmatter(skill: string): Record<string, string> {
  const raw = readFileSync(join(pluginDir, "skills", skill, "SKILL.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  expect(m).not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of m![1].split("\n")) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

describe("plugin skills", () => {
  it("ships exactly scan, review, stats, autopilot", () => {
    expect(readdirSync(join(pluginDir, "skills")).sort()).toEqual(["autopilot", "review", "scan", "stats"]);
  });
  it("every skill has a description and invokes the bundled bin", () => {
    for (const s of ["scan", "review", "stats", "autopilot"]) {
      expect(frontmatter(s).description).toBeTruthy();
      const body = readFileSync(join(pluginDir, "skills", s, "SKILL.md"), "utf8");
      expect(body).toContain('node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs"');
      expect(body).not.toMatch(/(^|[^/])\bgradient (scan|review|apply|stats|autopilot)/); // no PATH fallback
    }
  });
  it("only autopilot is user-invocation-only", () => {
    expect(frontmatter("autopilot")["disable-model-invocation"]).toBe("true");
    for (const s of ["scan", "review", "stats"]) {
      expect(frontmatter(s)["disable-model-invocation"]).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/plugin.test.ts`
Expected: FAIL — skills directory missing.

- [ ] **Step 3: Create the four SKILL.md files.**

`plugin/skills/scan/SKILL.md`:

```markdown
---
name: scan
description: Find repeated Claude Code workflows in the user's own transcript history. Use when the user wants to mine their history, asks what they keep retyping, or wants automation suggestions.
---

Run the bundled gradient CLI (read-only — it only caches suggestions):

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" scan

- Default scope is this project's history. Add `--user` (all projects, recent
  window) or `--all` only when the user explicitly asks for cross-project results.
- Summarize the printed suggestions, then point the user at `/gradient:review`.
- If the command fails to start, the plugin install is broken — tell the user
  to reinstall the gradient plugin. Never fall back to a PATH-installed gradient.
```

`plugin/skills/review/SKILL.md`:

```markdown
---
name: review
description: Review and apply gradient's cached suggestions — the workflows mined from the user's own history. Use after a scan, or when the user asks what gradient suggested or wants to approve suggestions.
---

1. List the cached suggestions:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" review --json

2. Present each one: name, title, type, evidence count/sessions, confidence,
   and a one-line summary of what applying would write.
3. Let the user choose. **Never apply without an explicit user choice in this
   conversation.**
4. For each approved id:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" apply <id>

5. Report exactly what was written (paths) or printed (loop lines / hook
   patches). `gradient remove <name>` undoes any artifact.
```

`plugin/skills/stats/SKILL.md`:

```markdown
---
name: stats
description: Show the user's most-repeated Claude Code patterns and how much is already automated. Use when the user asks how they use Claude Code or what gradient has covered.
---

Run and relay:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" stats

Highlight uncovered high-count patterns and suggest `/gradient:review` for them.
```

`plugin/skills/autopilot/SKILL.md`:

```markdown
---
name: autopilot
description: Turn gradient autopilot on or off — the opt-in Stop hook that answers routine nudges the way the user would.
disable-model-invocation: true
---

Autopilot authority is the user's decision; this skill only runs the exact
subcommand they asked for:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" autopilot <status|nudge|full|off>

- No argument given → run `status` and explain the modes: `nudge` pushes
  unfinished work forward; `full` also answers routine questions; both are
  bounded by a per-session budget and a progress gate; `off` removes the hook.
- Never choose a mode for the user.
```

- [ ] **Step 4: Run tests**

Run: `cd cli && npx vitest run src/plugin.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/skills/
git commit -m "feat(plugin): scan/review/stats/autopilot skills driving the bundled CLI"
```

---

### Task P5: Docs + wording pass

**Files:**
- Modify: `README.md` (root)
- Modify: `cli/README.md`
- Modify: `cli/src/skill/SKILL.md`

**Interfaces:** none (copy only).

- [ ] **Step 1: Root `README.md`** — in Quickstart, add the plugin path *above* the npx block:

```markdown
## Quickstart

**Plugin (recommended):** in Claude Code run
`/plugin marketplace add ylambda/gradient` then `/plugin install gradient`,
and use `/gradient:scan` → `/gradient:review`. Installing runs nothing —
every automation stays opt-in.

**CLI (npx):**
```

(keep the existing npx block below it, unchanged).

- [ ] **Step 2: `cli/README.md`** — under Development, add a release checklist:

```markdown
## Releasing

1. Bump `version` in `package.json`.
2. `npm run build:plugin` — regenerates `../plugin/bin/gradient.mjs` and syncs
   `../plugin/.claude-plugin/plugin.json`. Commit both with the bump
   (the version-sync test fails otherwise).
```

- [ ] **Step 3: `cli/src/skill/SKILL.md`** (the npx flow's user-level skill) — its `gradient review` bullet points at the interactive readline flow, which cannot run under the Bash tool. Replace the Usage list's review/apply lines with:

```markdown
- `gradient review --json` — list cached suggestions; present them and let the
  user choose (the interactive `gradient review` is for the terminal, not here).
- `gradient apply <id>` — generate an approved suggestion non-interactively.
```

- [ ] **Step 4: Full test run**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS (all suites, including plugin guards).

- [ ] **Step 5: Commit**

```bash
git add README.md cli/README.md cli/src/skill/SKILL.md
git commit -m "docs: plugin install path, release checklist, fix npx skill's review wording"
```
