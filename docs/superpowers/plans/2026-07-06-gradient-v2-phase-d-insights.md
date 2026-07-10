# gradient v2 Phase D — Insights & Continuity Pack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `gradient insights` — a local-only behavior report (nudges, context deaths, interrupts, error pastes, model churn, adoption) where every metric pairs with a gradient action — plus the continuity pack: `gradient continuity on` installs PreCompact `checkpoint` + SessionStart(`resume|compact`) `recap` hooks, productizing the user's hand-rolled `/sum`. Spec: `docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md` §6.

**Architecture:** `core/insights.ts` computes `InsightsMetrics` in one pass over unfiltered turns (reusing Phase A's `classifyPrompt` and Phase C's `extractPasteKey`), sums autopilot-avoided nudges from `core/state.ts` session files, and builds recommendation lines. `commands/insights.ts` orchestrates scope/collect/render; `--html` writes a dependency-free single file. `commands/recap.ts` + a `matcher` option in `core/settings.ts` complete the continuity pack.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest, zero new runtime dependencies. All work in `cli/`.

## Global Constraints

- **Depends on Phases A (classifier) and C (`extractPasteKey`).** Phase B's adoption data is consumed when present, degraded gracefully when absent (spec §9). Branch: `spec/v2-phase-d`.
- **No LLM anywhere in this phase** — the numbers speak (spec §6).
- **Spec deviation (recorded):** the continuity pack ships as an explicit opt-in command (`gradient continuity on|off|status`), not as an LLM-emitted paired-hook suggestion — pairing two hooks through the detect prompt is unreliable, and the opt-in command is the same consent model as `autopilot`/`recall`. `insights` recommends the command.
- **`--user` scope** shares `scan --user` semantics: all projects bounded by `userScopeDays` (default 7) — resolves spec §11's open question in favor of consistency.
- **Stats vs insights division (spec §6):** `stats` = artifact view; `insights` = behavior view. No duplicated sections.
- `recap` prints `progress.md` to stdout (SessionStart stdout re-enters context); missing file → print nothing, exit 0. `recap` and `checkpoint` are the only two continuity hook targets.
- **HTML:** self-contained (inline CSS, no external refs), written to `.gradient/insights.html`.
- Tests: vitest with injected deps, no network. Run from `cli/`: `npm test`, `npm run typecheck`.

## File structure

| File | Responsibility |
|------|----------------|
| `cli/src/core/insights.ts` (create) | `isNudgeText`, `computeMetrics`, `sumAutopilotAvoided`, `buildRecommendations`, `renderInsightsHtml` |
| `cli/src/commands/insights.ts` (create) | scope resolve → collect/parse → report assembly → render/write |
| `cli/src/commands/recap.ts` (create) | print `progress.md` for SessionStart |
| `cli/src/commands/checkpoint.ts` (modify) | append a redacted assistant-tail excerpt |
| `cli/src/commands/continuity.ts` (create) | `on|off|status` for the paired hooks |
| `cli/src/core/settings.ts` (modify) | optional `matcher` on hook groups |
| `cli/src/core/validate.ts` (modify) | `KNOWN_SUBCOMMANDS` += `"recap"` |
| `cli/src/cli.ts` (modify) | `insights`, `recap`, `continuity` dispatch + HELP |
| `README.md` (modify) | insights + continuity sections |

---

### Task D1: Metrics engine

**Files:**
- Create: `cli/src/core/insights.ts`
- Test: `cli/src/core/insights.test.ts` (create)

**Interfaces:**
- Consumes: `classifyPrompt`, `compileIgnorePatterns` (Phase A), `extractPasteKey` (Phase C), `Turn`.
- Produces (D2/D3 rely on these exact names):
  - `isNudgeText(text: string): boolean` — the shared nudge lexicon (continue/keep going/what's next/yes/ok/lgtm/looks good/ship it/proceed/next, punctuation-tolerant, case-insensitive, full-string match)
  - `interface InsightsMetrics { prompts: number; nudges: number; interrupts: number; continuations: number; notifications: number; compacts: number; modelSwitches: number; effortSwitches: number; errorPastes: number }`
  - `computeMetrics(turns: Turn[], ignore?: RegExp[]): InsightsMetrics` — single pass over **unfiltered** turns: `[Request interrupted` prefix → interrupts; `<command-name>` tags for compact/model/effort; `classifyPrompt` buckets continuation/notification; human prompts count toward `prompts`, then nudge/paste checks.

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/insights.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isNudgeText, computeMetrics } from "./insights.js";
import type { Turn } from "./types.js";

const t = (text: string): Turn => ({ ts: "2026-07-01T00:00:00Z", project: "p", role: "user", sessionId: "s", text });

describe("isNudgeText", () => {
  it.each(["continue", "Continue.", "what's next?", "lgtm", "Looks good.", "yes", "ship it"])("recognizes %s", s => {
    expect(isNudgeText(s)).toBe(true);
  });
  it.each(["continue the refactor in auth.ts", "yesterday's build failed"])("rejects %s", s => {
    expect(isNudgeText(s)).toBe(false);
  });
});

describe("computeMetrics", () => {
  it("counts each metric from a mixed transcript", () => {
    const turns = [
      t("continue"),
      t("fix the login bug"),
      t("[Request interrupted by user]"),
      t("This session is being continued from a previous conversation."),
      t("<command-name>/compact</command-name>"),
      t("<command-name>/model</command-name> opus"),
      t("<command-name>/effort</command-name>"),
      t("<task-notification>x</task-notification>"),
      t("make dev\n" + "error: boom\n".repeat(40)),
    ];
    expect(computeMetrics(turns)).toEqual({
      prompts: 3, nudges: 1, interrupts: 1, continuations: 1, notifications: 1,
      compacts: 1, modelSwitches: 1, effortSwitches: 1, errorPastes: 1,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/insights.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `cli/src/core/insights.ts`:

```ts
import type { Turn } from "./types.js";
import { classifyPrompt } from "./filter.js";
import { extractPasteKey } from "./paste.js";

const NUDGE_RE = /^(continue|go on|keep going|next|what'?s next|proceed|yes|y|ok|okay|do it|go|sure|yep|good|great|perfect|lgtm|looks good|approved?|ship it|sounds good)[.!?]*$/i;

export function isNudgeText(text: string): boolean {
  return NUDGE_RE.test(text.trim());
}

export interface InsightsMetrics {
  prompts: number; nudges: number; interrupts: number;
  continuations: number; notifications: number;
  compacts: number; modelSwitches: number; effortSwitches: number;
  errorPastes: number;
}

const TAG_RE = /<command-name>\/?([\w:-]+)<\/command-name>/;

export function computeMetrics(turns: Turn[], ignore: RegExp[] = []): InsightsMetrics {
  const m: InsightsMetrics = {
    prompts: 0, nudges: 0, interrupts: 0, continuations: 0, notifications: 0,
    compacts: 0, modelSwitches: 0, effortSwitches: 0, errorPastes: 0,
  };
  for (const t of turns) {
    if (t.role !== "user" || !t.text) continue;
    const text = t.text.trim();
    if (text.startsWith("[Request interrupted")) { m.interrupts++; continue; }
    const tag = TAG_RE.exec(text);
    if (tag) {
      if (tag[1] === "compact") m.compacts++;
      else if (tag[1] === "model") m.modelSwitches++;
      else if (tag[1] === "effort") m.effortSwitches++;
      continue;
    }
    switch (classifyPrompt(text, ignore)) {
      case "continuation": m.continuations++; continue;
      case "notification": m.notifications++; continue;
      case "injected": continue;
      case "human": break;
    }
    m.prompts++;
    if (isNudgeText(text)) m.nudges++;
    if (extractPasteKey(text)) m.errorPastes++;
  }
  return m;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/insights.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/insights.ts cli/src/core/insights.test.ts
git commit -m "feat(core): insights metrics engine — one pass, no LLM"
```

---

### Task D2: Autopilot-avoided + recommendations

**Files:**
- Modify: `cli/src/core/insights.ts`
- Test: `cli/src/core/insights.test.ts` (append)

**Interfaces:**
- Consumes: `stateDir`, `loadState` (`core/state.ts`), `Config`, `AutopilotMode`, `InsightsMetrics`.
- Produces:
  - `sumAutopilotAvoided(home?: string): Promise<number>` — sum of `count` across `<stateDir>/*.json` (7-day window by virtue of `cleanupStale`); missing dir → 0.
  - `interface Recommendation { metric: string; line: string }`
  - `buildRecommendations(m: InsightsMetrics, ctx: { autopilotMode: AutopilotMode | undefined; avoided: number; recallInstalled: boolean; unusedArtifacts: string[] }): Recommendation[]` — exact mapping (spec §6 table):
    - `nudges > 10 && autopilot off/undefined` → `"gradient autopilot nudge"`; autopilot on → `"autopilot on — ${avoided} nudge(s) avoided (7d)"`
    - `continuations + compacts > 10` → `"gradient continuity on"`
    - `interrupts > 20` → plan-mode note (informational)
    - `errorPastes > 10` → `"run gradient scan — paste patterns become skills"`
    - `modelSwitches > 10` → per-project `defaultModel` in `.claude/settings.json`
    - `!recallInstalled` → `"gradient recall on"`
    - `unusedArtifacts.length > 0` → `"gradient remove <name>"` per name
    - always last: permission friction → pointer to Claude Code's built-in `/fewer-permission-prompts` (spec Decision 8)

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/insights.test.ts`:

```ts
import { sumAutopilotAvoided, buildRecommendations } from "./insights.js";
import { saveState } from "./state.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("sumAutopilotAvoided", () => {
  it("sums counts across session state files; 0 without a dir", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-ins-"));
    await saveState("a", { count: 3, lastFingerprint: "", stoodDown: false, log: [] }, home);
    await saveState("b", { count: 2, lastFingerprint: "", stoodDown: false, log: [] }, home);
    expect(await sumAutopilotAvoided(home)).toBe(5);
    expect(await sumAutopilotAvoided(await mkdtemp(join(tmpdir(), "grad-emp-")))).toBe(0);
  });
});

describe("buildRecommendations", () => {
  const m = { prompts: 100, nudges: 30, interrupts: 25, continuations: 10, notifications: 0,
    compacts: 5, modelSwitches: 15, effortSwitches: 0, errorPastes: 12 };
  it("routes each hot metric to a gradient action", () => {
    const recs = buildRecommendations(m, { autopilotMode: undefined, avoided: 0, recallInstalled: false, unusedArtifacts: ["dead"] });
    const all = recs.map(r => r.line).join("\n");
    expect(all).toContain("gradient autopilot nudge");
    expect(all).toContain("gradient continuity on");
    expect(all).toContain("gradient recall on");
    expect(all).toContain("gradient remove dead");
    expect(all).toContain("defaultModel");
    expect(all).toContain("fewer-permission-prompts");
  });
  it("reports avoided nudges when autopilot is on", () => {
    const recs = buildRecommendations(m, { autopilotMode: "nudge", avoided: 7, recallInstalled: true, unusedArtifacts: [] });
    expect(recs.map(r => r.line).join("\n")).toContain("7 nudge(s) avoided");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/insights.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Implement** — append to `cli/src/core/insights.ts`:

```ts
import { readdir } from "node:fs/promises";
import { stateDir, loadState } from "./state.js";
import type { AutopilotMode } from "./types.js";

export async function sumAutopilotAvoided(home?: string): Promise<number> {
  try {
    let sum = 0;
    for (const f of await readdir(stateDir(home))) {
      if (!f.endsWith(".json")) continue;
      sum += (await loadState(f.slice(0, -5), home)).count;
    }
    return sum;
  } catch { return 0; }
}

export interface Recommendation { metric: string; line: string }

export function buildRecommendations(
  m: InsightsMetrics,
  ctx: { autopilotMode: AutopilotMode | undefined; avoided: number; recallInstalled: boolean; unusedArtifacts: string[] },
): Recommendation[] {
  const out: Recommendation[] = [];
  const autopilotOn = ctx.autopilotMode === "nudge" || ctx.autopilotMode === "full";
  if (autopilotOn) out.push({ metric: "nudges", line: `autopilot on — ${ctx.avoided} nudge(s) avoided (7d)` });
  else if (m.nudges > 10) out.push({ metric: "nudges", line: `you typed ${m.nudges} nudges — try: gradient autopilot nudge` });
  if (m.continuations + m.compacts > 10) out.push({ metric: "context", line: `${m.continuations} context death(s), ${m.compacts} compact(s) — try: gradient continuity on` });
  if (m.interrupts > 20) out.push({ metric: "interrupts", line: `${m.interrupts} interrupted turns — consider plan mode for bigger asks` });
  if (m.errorPastes > 10) out.push({ metric: "pastes", line: `${m.errorPastes} pasted error dumps — run gradient scan; paste patterns become skills` });
  if (m.modelSwitches > 10) out.push({ metric: "model", line: `${m.modelSwitches} /model switches — pin defaultModel in .claude/settings.json per project` });
  if (!ctx.recallInstalled) out.push({ metric: "recall", line: "recall hook off — gradient recall on hints when a typed prompt matches an artifact" });
  for (const name of ctx.unusedArtifacts) out.push({ metric: "adoption", line: `unused 30d+: gradient remove ${name}` });
  out.push({ metric: "permissions", line: "permission friction? Claude Code's built-in /fewer-permission-prompts mines an allowlist" });
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npx vitest run src/core/insights.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/insights.ts cli/src/core/insights.test.ts
git commit -m "feat(core): insights recommendations — every metric routes to an action"
```

---

### Task D3: `gradient insights` command + CLI

**Files:**
- Create: `cli/src/commands/insights.ts`
- Test: `cli/src/commands/insights.test.ts` (create)
- Modify: `cli/src/cli.ts`

**Interfaces:**
- Consumes: `collect`, `parseFile`, `computeMetrics`, `sumAutopilotAvoided`, `buildRecommendations`, `loadConfig`, `hookInstalled`, `stats` (Phase B adoption — absence tolerated), `compileIgnorePatterns`.
- Produces:
  - `interface InsightsReport { label: string; metrics: InsightsMetrics; avoided: number; recommendations: Recommendation[] }`
  - `insights(opts: { projectDir: string; user?: boolean; home?: string }, deps?: { collectFn?, parseFn?, config?: Config }): Promise<InsightsReport>` — project scope by default; `--user` = all projects bounded by `userScopeDays ?? 7`; `unusedArtifacts` from Phase B's `stats(...).adoption` filtered on `suggestRemoval` (wrapped in try/catch → `[]` when unavailable); `recallInstalled` from `hookInstalled(projectDir, "UserPromptSubmit", "gradient recall")`.
  - CLI: `gradient insights [--user] [--html]` renders metric lines + recommendation lines; HELP line added.

- [ ] **Step 1: Write the failing tests** — create `cli/src/commands/insights.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insights } from "./insights.js";
import type { Turn } from "../core/types.js";

let dir: string; let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "grad-insc-"));
  home = await mkdtemp(join(tmpdir(), "grad-insh-"));
});

const nudgeTurns: Turn[] = Array.from({ length: 12 }, (_, i) =>
  ({ ts: "2026-07-01T00:00:00Z", project: "p", role: "user", sessionId: `s${i}`, text: "continue" }));

describe("insights", () => {
  it("assembles metrics + recommendations for the project scope", async () => {
    const r = await insights({ projectDir: dir, home }, { collectFn: async () => ["f"], parseFn: async () => nudgeTurns });
    expect(r.metrics.nudges).toBe(12);
    expect(r.recommendations.map(x => x.line).join("\n")).toContain("gradient autopilot nudge");
    expect(r.label).toContain("project");
  });
  it("runs green on an empty project (all zeros, no crash)", async () => {
    const r = await insights({ projectDir: dir, home }, { collectFn: async () => [], parseFn: async () => [] });
    expect(r.metrics.prompts).toBe(0);
    expect(r.recommendations.length).toBeGreaterThan(0); // the permissions pointer always renders
  });
  it("--user widens scope with the 7d default window", async () => {
    let captured: unknown;
    await insights({ projectDir: dir, user: true, home }, {
      collectFn: async o => { captured = o; return []; }, parseFn: async () => [],
    });
    expect(captured).toMatchObject({ scope: "all", sinceDays: 7 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/commands/insights.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `cli/src/commands/insights.ts`:

```ts
import type { Config, Turn } from "../core/types.js";
import { collect, type CollectOptions } from "../core/collect.js";
import { parseFile } from "../core/parse.js";
import { compileIgnorePatterns } from "../core/filter.js";
import {
  computeMetrics, sumAutopilotAvoided, buildRecommendations,
  type InsightsMetrics, type Recommendation,
} from "../core/insights.js";
import { hookInstalled } from "../core/settings.js";
import { DEFAULT_USER_SCOPE_DAYS } from "../core/scope.js";
import { loadConfig } from "../config.js";
import { stats } from "./stats.js";

export interface InsightsReport {
  label: string;
  metrics: InsightsMetrics;
  avoided: number;
  recommendations: Recommendation[];
}

export interface InsightsDeps {
  collectFn?: (o: CollectOptions) => Promise<string[]>;
  parseFn?: (path: string) => Promise<Turn[]>;
  config?: Config;
}

export async function insights(
  opts: { projectDir: string; user?: boolean; home?: string },
  deps: InsightsDeps = {},
): Promise<InsightsReport> {
  const config = deps.config ?? (await loadConfig(opts.home));
  const collectFn = deps.collectFn ?? collect;
  const parseFn = deps.parseFn ?? parseFile;

  const days = config.userScopeDays ?? DEFAULT_USER_SCOPE_DAYS;
  const scope: CollectOptions = opts.user
    ? { scope: "all", sinceDays: days, home: opts.home }
    : { scope: "project", projectPath: opts.projectDir, home: opts.home };
  const label = opts.user ? `user scope · last ${days}d` : "project scope · all history";

  const turns: Turn[] = [];
  for (const f of await collectFn(scope)) turns.push(...(await parseFn(f)));
  const metrics = computeMetrics(turns, compileIgnorePatterns(config.ignorePatterns));

  const avoided = await sumAutopilotAvoided(opts.home);
  const recallInstalled = await hookInstalled(opts.projectDir, "UserPromptSubmit", "gradient recall");
  let unusedArtifacts: string[] = [];
  try {
    const s = await stats(opts.projectDir, { home: opts.home, collectFn, parseFn });
    unusedArtifacts = s.adoption.filter(a => a.suggestRemoval).map(a => a.name);
  } catch { /* Phase B data unavailable — degrade gracefully (spec §9) */ }

  return {
    label, metrics, avoided,
    recommendations: buildRecommendations(metrics, { autopilotMode: config.autopilot, avoided, recallInstalled, unusedArtifacts }),
  };
}
```

`cli/src/cli.ts` — add `html: { type: "boolean" }` to `parseCliArgs` options and wire terminal output only; the `--html` flag is read in Task D4 (until then it parses but does nothing):

```ts
case "insights": {
  log(banner(VERSION));
  const r = await insights({ projectDir, user: !!flags.user });
  log(c.dim(r.label));
  const m = r.metrics;
  log(`  ${c.bold("prompts")} ${m.prompts}   ${c.bold("nudges")} ${m.nudges}   ${c.bold("interrupts")} ${m.interrupts}`);
  log(`  ${c.bold("context deaths")} ${m.continuations}   ${c.bold("compacts")} ${m.compacts}   ${c.bold("error pastes")} ${m.errorPastes}`);
  log(`  ${c.bold("model switches")} ${m.modelSwitches}   ${c.bold("effort switches")} ${m.effortSwitches}`);
  log("");
  for (const rec of r.recommendations) log(`  ${c.violet("→")} ${rec.line}`);
  return 0;
}
```

HELP line: `gradient insights [--user] [--html]  behavior report + what to automate next`.

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/insights.ts cli/src/commands/insights.test.ts cli/src/cli.ts
git commit -m "feat(cli): gradient insights — behavior metrics routed to gradient actions"
```

---

### Task D4: HTML report

**Files:**
- Modify: `cli/src/core/insights.ts`, `cli/src/commands/insights.ts`, `cli/src/cli.ts`
- Test: `cli/src/core/insights.test.ts` (append)

**Interfaces:**
- Produces:
  - `renderInsightsHtml(report: InsightsReport): string` — one self-contained document: `<style>` inline, no `<script>`, no external URLs; metrics as a definition grid; recommendations as a list. HTML-escapes all dynamic strings.
  - `writeInsightsHtml(projectDir: string, report: InsightsReport): Promise<string>` (in `commands/insights.ts`) → writes `.gradient/insights.html`, returns the path.
  - CLI `--html` calls it after rendering the terminal view and logs the path.

- [ ] **Step 1: Write the failing tests** — append to `cli/src/core/insights.test.ts`:

```ts
import { renderInsightsHtml } from "./insights.js";

describe("renderInsightsHtml", () => {
  const report = {
    label: "project scope", avoided: 2,
    metrics: { prompts: 10, nudges: 3, interrupts: 1, continuations: 2, notifications: 0, compacts: 4, modelSwitches: 0, effortSwitches: 0, errorPastes: 1 },
    recommendations: [{ metric: "nudges", line: "try <gradient autopilot nudge> & friends" }],
  };
  it("is self-contained and escapes content", () => {
    const html = renderInsightsHtml(report);
    expect(html).toContain("<style>");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("&lt;gradient autopilot nudge&gt;");   // escaped
    expect(html).toContain("project scope");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/insights.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — append to `cli/src/core/insights.ts` (import the report type via a local structural type to avoid a commands→core cycle):

```ts
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderInsightsHtml(report: {
  label: string; avoided: number; metrics: InsightsMetrics; recommendations: Recommendation[];
}): string {
  const m = report.metrics;
  const rows: Array<[string, number]> = [
    ["prompts", m.prompts], ["nudges", m.nudges], ["interrupts", m.interrupts],
    ["context deaths", m.continuations], ["compacts", m.compacts],
    ["error pastes", m.errorPastes], ["model switches", m.modelSwitches], ["effort switches", m.effortSwitches],
  ];
  return `<!doctype html><meta charset="utf-8"><title>gradient insights</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1a1a1a}
  @media (prefers-color-scheme:dark){body{background:#111;color:#eee}}
  h1{font-size:18px} .label{opacity:.6}
  dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px}
  dt{opacity:.6} dd{margin:0;font-variant-numeric:tabular-nums}
  ul{padding-left:18px} li{margin:6px 0}
</style>
<h1>gradient insights</h1>
<p class="label">${escapeHtml(report.label)} · autopilot avoided ${report.avoided} nudge(s)</p>
<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("")}</dl>
<h1>next</h1>
<ul>${report.recommendations.map(r => `<li>${escapeHtml(r.line)}</li>`).join("")}</ul>
`;
}
```

In `commands/insights.ts`:

```ts
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gradientDir } from "../core/manifest.js";
import { renderInsightsHtml } from "../core/insights.js";

export async function writeInsightsHtml(projectDir: string, report: InsightsReport): Promise<string> {
  const p = join(gradientDir(projectDir), "insights.html");
  await mkdir(gradientDir(projectDir), { recursive: true });
  await writeFile(p, renderInsightsHtml(report));
  return p;
}
```

In `cli.ts`'s insights case, after the recommendation loop:

```ts
if (flags.html) log(`${c.ok("wrote")} ${c.muted(await writeInsightsHtml(projectDir, r))}`);
```

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/insights.ts cli/src/core/insights.test.ts cli/src/commands/insights.ts cli/src/cli.ts
git commit -m "feat(insights): self-contained HTML report (--html)"
```

---

### Task D5: Continuity pack — recap, richer checkpoint, matcher hooks, `gradient continuity`

**Files:**
- Create: `cli/src/commands/recap.ts`, `cli/src/commands/continuity.ts`
- Modify: `cli/src/commands/checkpoint.ts`, `cli/src/core/settings.ts`, `cli/src/core/validate.ts`, `cli/src/cli.ts`, `README.md`
- Test: `cli/src/commands/checkpoint.test.ts` (append), `cli/src/commands/continuity.test.ts` (create), `cli/src/core/settings.test.ts` (append)

**Interfaces:**
- Consumes: `installHook`/`removeHook`/`hookInstalled`, `renderTail`/`readTranscriptLines` (`core/tail.ts`), `redact` (`core/security.ts`).
- Produces:
  - `settings.ts`: `mergeHookIntoSettings(existing, event, command, opts?: { timeout?: number; matcher?: string })` — matcher lands on the hook **group** (`{ matcher, hooks: [...] }`); dedupe stays command-based; `installHook` forwards it. `removeHook` unchanged (matches by command).
  - `recap.ts`: `recap(projectDir: string): Promise<string | null>` — contents of `<projectDir>/progress.md` or null.
  - `checkpoint.ts`: `progress.md` gains a `## Where things stood` section — `redact(renderTail(lines, { maxTurns: 6, maxChars: 1500 }))`.
  - `continuity.ts`: `setContinuity(on: boolean, projectDir: string): Promise<{ on: boolean; settingsPath: string }>` — on: install `PreCompact` → `gradient checkpoint` and `SessionStart` (matcher `"resume|compact"`) → `gradient recap`; off: remove both. `continuityStatus(projectDir): Promise<{ checkpoint: boolean; recap: boolean }>`.
  - `validate.ts`: `KNOWN_SUBCOMMANDS` = `{"checkpoint", "scan", "recap"}`.
  - CLI: `continuity <on|off|status>`, `recap` (prints content or nothing, exit 0). HELP lines. `insights`'s context recommendation already points here (D2).

- [ ] **Step 1: Write the failing tests**

Append to `cli/src/core/settings.test.ts`:

```ts
it("adds a matcher to the hook group when given", () => {
  const out = mergeHookIntoSettings({}, "SessionStart", "gradient recap", { matcher: "resume|compact" });
  expect(out.hooks.SessionStart[0]).toEqual({ matcher: "resume|compact", hooks: [{ type: "command", command: "gradient recap" }] });
});
```

Append to `cli/src/commands/checkpoint.test.ts` (reuse its transcript-fixture pattern):

```ts
it("includes a redacted assistant tail section", async () => {
  const lines = [
    JSON.stringify({ type: "user", sessionId: "s", message: { role: "user", content: "deploy with API_KEY=abc123secret" } }),
    JSON.stringify({ type: "assistant", sessionId: "s", message: { role: "assistant", content: [{ type: "text", text: "Deployed to staging." }] } }),
  ];
  const path = await checkpoint({ transcript_path: "t" }, dir, async () => parseLines(lines), async () => lines);
  const md = await readFile(path, "utf8");
  expect(md).toContain("## Where things stood");
  expect(md).toContain("Deployed to staging.");
  expect(md).not.toContain("abc123secret");
});
```

Create `cli/src/commands/continuity.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setContinuity, continuityStatus } from "./continuity.js";
import { recap } from "./recap.js";
import { writeFile } from "node:fs/promises";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "grad-cont-")); });

describe("continuity", () => {
  it("on installs both hooks; off removes both", async () => {
    await setContinuity(true, dir);
    const s = JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8"));
    expect(JSON.stringify(s.hooks.PreCompact)).toContain("gradient checkpoint");
    expect(s.hooks.SessionStart[0]).toMatchObject({ matcher: "resume|compact" });
    expect(await continuityStatus(dir)).toEqual({ checkpoint: true, recap: true });
    await setContinuity(false, dir);
    expect(await continuityStatus(dir)).toEqual({ checkpoint: false, recap: false });
  });
});

describe("recap", () => {
  it("returns progress.md content, null when absent", async () => {
    expect(await recap(dir)).toBeNull();
    await writeFile(join(dir, "progress.md"), "# Progress checkpoint\nstuff");
    expect(await recap(dir)).toContain("stuff");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd cli && npx vitest run src/core/settings.test.ts src/commands/checkpoint.test.ts src/commands/continuity.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`cli/src/core/settings.ts` — widen the option through `mergeHookIntoSettings` and `installHook`:

```ts
export function mergeHookIntoSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
  opts: { timeout?: number; matcher?: string } = {},
): Record<string, any> {
  // unchanged until group construction:
  if (!already) {
    const hook: { type: string; command: string; timeout?: number } = { type: "command", command };
    if (opts.timeout !== undefined) hook.timeout = opts.timeout;
    const group: HookGroup & { matcher?: string } = { hooks: [hook] };
    if (opts.matcher !== undefined) group.matcher = opts.matcher;
    groups.push(group);
  }
```

(`installHook`'s `opts` type gains `matcher?: string`; body already forwards `opts`.)

`cli/src/commands/recap.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** SessionStart(resume|compact) hook target: stdout re-enters context.
 * Missing progress.md → null → the CLI prints nothing and exits 0. */
export async function recap(projectDir: string): Promise<string | null> {
  try { return await readFile(join(projectDir, "progress.md"), "utf8"); } catch { return null; }
}
```

`cli/src/commands/checkpoint.ts` — add tail rendering (new deps parameter keeps tests hermetic):

```ts
import { renderTail, readTranscriptLines } from "../core/tail.js";
import { redact } from "../core/security.js";

export async function checkpoint(
  input: CheckpointInput,
  projectDir: string,
  parseFn: (path: string) => Promise<Turn[]> = parseFile,
  readLinesFn: (path: string) => Promise<string[]> = readTranscriptLines,
): Promise<string> {
  const turns = input.transcript_path ? await parseFn(input.transcript_path) : [];
  const prompts = filterPrompts(turns).slice(-10);
  const lines = prompts.map(p => `- ${p.text}`).join("\n");
  let tail = "";
  if (input.transcript_path) {
    try { tail = redact(renderTail(await readLinesFn(input.transcript_path), { maxTurns: 6, maxChars: 1500 })); } catch { /* tail is optional */ }
  }
  const md = `# Progress checkpoint\n\nRecent intents before compaction:\n\n${lines}\n` +
    (tail ? `\n## Where things stood\n\n${tail}\n` : "");
  const path = join(projectDir, "progress.md");
  await writeFile(path, md);
  return path;
}
```

`cli/src/commands/continuity.ts`:

```ts
import { installHook, removeHook, hookInstalled, settingsPath } from "../core/settings.js";

export async function setContinuity(on: boolean, projectDir: string): Promise<{ on: boolean; settingsPath: string }> {
  if (on) {
    await installHook(projectDir, "PreCompact", "gradient checkpoint");
    const p = await installHook(projectDir, "SessionStart", "gradient recap", { matcher: "resume|compact" });
    return { on: true, settingsPath: p };
  }
  await removeHook(projectDir, "PreCompact", "gradient checkpoint");
  const p = await removeHook(projectDir, "SessionStart", "gradient recap");
  return { on: false, settingsPath: p };
}

export async function continuityStatus(projectDir: string): Promise<{ checkpoint: boolean; recap: boolean }> {
  return {
    checkpoint: await hookInstalled(projectDir, "PreCompact", "gradient checkpoint"),
    recap: await hookInstalled(projectDir, "SessionStart", "gradient recap"),
  };
}
```

`cli/src/core/validate.ts`: `KNOWN_SUBCOMMANDS = new Set(["checkpoint", "scan", "recap"])`.

`cli/src/cli.ts` — cases (recap mirrors the hook exit-0 contract) + HELP lines `gradient continuity <on|off|status>  checkpoint before compaction, recap on resume`:

```ts
case "recap": {
  const text = await recap(projectDir);
  if (text) log(text);
  return 0;
}
case "continuity": {
  const arg = positionals[0] ?? "status";
  if (arg === "on" || arg === "off") {
    const r = await setContinuity(arg === "on", projectDir);
    log(r.on ? `${c.ok("continuity hooks installed")} ${c.muted(r.settingsPath)}` : `${c.muted("continuity hooks removed:")} ${r.settingsPath}`);
    return 0;
  }
  const s = await continuityStatus(projectDir);
  log(`${c.muted("checkpoint (PreCompact):")} ${s.checkpoint ? c.ok("on") : "off"}   ${c.muted("recap (SessionStart):")} ${s.recap ? c.ok("on") : "off"}`);
  return 0;
}
```

`README.md`: continuity section under insights ("your `/sum`, productized: checkpoint before compaction, recap after resume — `gradient continuity on`").

- [ ] **Step 4: Run to verify pass**

Run: `cd cli && npm test && npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/settings.ts cli/src/core/settings.test.ts cli/src/commands/recap.ts cli/src/commands/checkpoint.ts cli/src/commands/checkpoint.test.ts cli/src/commands/continuity.ts cli/src/commands/continuity.test.ts cli/src/core/validate.ts cli/src/cli.ts README.md
git commit -m "feat(cli): continuity pack — checkpoint+recap hooks behind gradient continuity"
```

---

## Execution notes (2026-07-09)

- **D2 seven-day accounting:** `sumAutopilotAvoided` explicitly runs stale
  state cleanup before summing; it does not assume another autopilot command
  happened to clean the directory recently. Model *or effort* churn can trigger
  the settings recommendation, matching the combined metric in the spec.
- **D3 one-pass contract:** the plan called `stats()`, which would collect and
  parse the transcript corpus a second time. Adoption-row construction is now
  reusable over the already-parsed turns, so project insights collect and parse
  exactly once. Bounded `--user` reports omit 30-day removal claims because a
  seven-day corpus cannot prove an artifact was unused for 30 days.
- **D4 HTML:** core and command-level tests cover escaping, inline-only CSS,
  no scripts or external URLs, and the `.gradient/insights.html` write path.
- **D5 matcher contract:** verified against the current official Claude Code
  hooks reference: `SessionStart` sources include `resume` and `compact`, and a
  pipe-separated exact matcher is supported. Re-running `continuity on` repairs
  a missing matcher. Matcher upgrades isolate the target command so unrelated
  hooks in a shared group retain their original matcher.
- **D5 checkpoint privacy:** the planned tail-only redaction still left the
  existing recent-intents section raw. Both recent intents and transcript lines
  are now redacted before persistence, preventing an inline credential from
  entering `progress.md`.
- **D5 manager UX:** unknown continuity actions return usage error 2 instead of
  silently showing status; status requires the correct recap matcher, not just
  a command with the same name.
- **Dogfood:** a real seven-day local report completed without an LLM (529 human
  prompts; 50 nudges; 18 continuations; 23 compacts; 39 interrupts; 19 model
  switches). In a clean temp project, continuity on/status, checkpoint, redacted
  recap, continuity off/status, and `insights --html` all passed. The HTML was
  1,494 bytes with inline CSS, no script, and no external URL.
- **Validation:** 427 tests pass; typecheck, build, and package dry-run are
  clean.
