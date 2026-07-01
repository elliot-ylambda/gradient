# Continuous Mining & Scan Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sharpen gradient's scan pipeline — semantic dedup, `stats`/`explain`, an opt-in session-start scan, and scalable clustering — without adding a new subsystem.

**Architecture:** Ten TDD tasks over the existing `cli/src` pipeline. Dedup rides the LLM call `detect` already makes; clustering swaps its O(b²) merge for minhash-LSH; a `SessionStart` hook runs `gradient scan --detach` merged into the project `.claude/settings.json`; two read-only commands report over the existing caches.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node ≥20, vitest, zero new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-01-gradient-continuous-mining-design.md`

## Global Constraints

- **Node ≥ 20**, `"type": "module"` — all relative imports use the `.js` extension even from `.ts` sources.
- **No new runtime dependencies.** Only existing dep is `@anthropic-ai/sdk`. `core/*` stays dependency-free.
- **Tests colocated** next to source as `*.test.ts`; run with `npx vitest run <path>` (single file) or `npx vitest run`.
- **Redaction before any LLM call** — snippets pass through `security.redact` before leaving the machine (already enforced in `detect`).
- **Hooks call a `gradient` subcommand, never inline shell.** A hook is only valid if its subcommand is in `validate.ts` `KNOWN_SUBCOMMANDS`.
- **Path containment** — every filesystem write under a project stays inside `<project>/.claude` and is guarded by `security.assertInside`.
- **No `Date.now()`/`Math.random()` in `core/`** clustering/LSH — hashing is deterministic so tests are stable.
- **Commit trailers** — end every commit body with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01TGAJYYyjkCfk8c8BC7zf76`
- **Typecheck gate** — a task that changes a shared type runs `npm run typecheck` before committing.

---

### Task 1: `Candidate.sessionIds` — carry session identities through clustering

**Files:**
- Modify: `cli/src/core/types.ts` (Candidate interface)
- Modify: `cli/src/core/cluster.ts:62-75` (candidate-building loop)
- Modify: `cli/src/core/detect.test.ts` (fix Candidate literals for the new required field)
- Test: `cli/src/core/cluster.test.ts`

**Interfaces:**
- Produces: `Candidate.sessionIds: string[]` — the distinct session IDs a cluster was seen in (`sessions` remains the count). Task 2 unions these across merged clusters.

- [ ] **Step 1: Write the failing test** — append to `cli/src/core/cluster.test.ts` inside the `describe("cluster")` block:

```ts
it("exposes the distinct session ids on each candidate", () => {
  const turns = [u("continue", "s1"), u("continue", "s1"), u("continue", "s2")];
  const top = cluster(turns, { minCount: 2 })[0];
  expect([...top.sessionIds].sort()).toEqual(["s1", "s2"]);
  expect(top.sessions).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && npx vitest run src/core/cluster.test.ts -t "session ids"`
Expected: FAIL — `top.sessionIds` is `undefined`.

- [ ] **Step 3: Add the field to the type** — in `cli/src/core/types.ts`, add to the `Candidate` interface (after `sessions: number;`):

```ts
  sessions: number;
  sessionIds: string[];   // distinct session ids (for exact union when clusters merge)
```

- [ ] **Step 4: Populate it in `cluster.ts`** — in the `merged.forEach((b, i) => {…})` block, add `sessionIds` to the pushed candidate:

```ts
    candidates.push({
      kind: "unknown",
      signature: b.signature,
      examples: b.examples,
      count: b.count,
      sessions: b.sessions.size,
      sessionIds: [...b.sessions],
      confidence,
    });
```

- [ ] **Step 5: Fix existing Candidate literals** — in `cli/src/core/detect.test.ts`, update the `cand` helper and the two inline literals so they satisfy the required field:

```ts
const cand = (signature: string, count: number, confidence: any = "high"): Candidate =>
  ({ kind: "unknown", signature, examples: [signature], count, sessions: count, sessionIds: ["s"], confidence });
```

and the inline literal in the redaction test (and any other inline `Candidate` object) gains `sessionIds: ["s1", "s2", "s3"]` alongside its `sessions` field.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd cli && npx vitest run src/core/cluster.test.ts && npm run typecheck`
Expected: PASS; typecheck reports no errors.

- [ ] **Step 7: Commit**

```bash
git add cli/src/core/types.ts cli/src/core/cluster.ts cli/src/core/cluster.test.ts cli/src/core/detect.test.ts
git commit -m "feat(core): carry sessionIds on Candidate for exact merge union"
```

---

### Task 2: Semantic dedup in `detect` — merge synonymous clusters

**Files:**
- Modify: `cli/src/core/types.ts` (Suggestion: add optional `examples`)
- Modify: `cli/src/core/detect.ts` (prompt, schema, aggregation, examples)
- Test: `cli/src/core/detect.test.ts`

**Interfaces:**
- Consumes: `Candidate.sessionIds` (Task 1).
- Produces: `detect` now honours `LlmSuggestion.sourceSignatures?: string[]` (still tolerates legacy `sourceSignature?: string`), summing `count` and set-unioning `sessions` across merged candidates, and populates `Suggestion.examples?: string[]` (redacted, ≤5). `candidateToCommand` also sets `examples`.

- [ ] **Step 1: Write the failing tests** — append to the `describe("detect")` block in `cli/src/core/detect.test.ts`:

```ts
it("merges synonymous clusters, summing counts and unioning sessions", async () => {
  const a: Candidate = { kind: "unknown", signature: "lgtm", examples: ["lgtm"], count: 5, sessions: 2, sessionIds: ["s1", "s2"], confidence: "high" };
  const b: Candidate = { kind: "unknown", signature: "looks good", examples: ["looks good"], count: 3, sessions: 2, sessionIds: ["s2", "s3"], confidence: "inferred" };
  const llm = {
    name: "fake", available: async () => true,
    complete: async () => JSON.stringify({ suggestions: [{
      sourceSignatures: ["lgtm", "looks good"],
      name: "approve", title: "Approve", rationale: "r", confidence: "high",
      payload: { type: "command", commandName: "approve", body: "lgtm" },
    }] }),
  };
  const out = await detect([a, b], llm);
  expect(out.length).toBe(1);
  expect(out[0].evidence.count).toBe(8);        // 5 + 3
  expect(out[0].evidence.sessions).toBe(3);     // union {s1,s2,s3}
});

it("populates redacted examples on a suggestion for explain", async () => {
  const llm = {
    name: "fake", available: async () => true,
    complete: async () => JSON.stringify({ suggestions: [{
      sourceSignatures: ["deploy with token sk-ant-xyz"],
      name: "deploy", title: "Deploy", rationale: "r", confidence: "high",
      payload: { type: "command", commandName: "deploy", body: "deploy" },
    }] }),
  };
  const c: Candidate = { kind: "unknown", signature: "deploy with token sk-ant-xyz", examples: ["deploy with token sk-ant-xyz"], count: 4, sessions: 1, sessionIds: ["s1"], confidence: "high" };
  const out = await detect([c], llm);
  expect(out[0].examples?.[0]).toContain("[REDACTED]");
  expect(out[0].examples?.[0]).not.toContain("sk-ant-xyz");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && npx vitest run src/core/detect.test.ts -t "merges synonymous"`
Expected: FAIL — count is 5 (only first source matched), not 8.

- [ ] **Step 3: Add `examples` to the Suggestion type** — in `cli/src/core/types.ts`, add to the `Suggestion` interface (after `confidence: Confidence;`):

```ts
  confidence: Confidence;
  examples?: string[];   // representative redacted prompts, for `explain`
```

- [ ] **Step 4: Update the prompt + interface** — in `cli/src/core/detect.ts`:

Change the `system` string in `buildDetectPrompt` to instruct merging and plural source signatures (replace the two lines describing `sourceSignature`):

```ts
    "Merge clusters that mean the same thing (e.g. 'lgtm' and 'looks good') into ONE suggestion. " +
    "Echo back EVERY merged cluster's exact 'signature' in a 'sourceSignatures' string array so evidence can be summed. " +
```

Update the `LlmSuggestion` interface:

```ts
interface LlmSuggestion {
  sourceSignatures?: string[];
  sourceSignature?: string;   // legacy single form still tolerated
  name: string; title: string; rationale: string; confidence: Confidence;
  payload: Suggestion["payload"];
}
```

- [ ] **Step 5: Aggregate evidence + examples** — in `detect`, replace the `.map(s => {…})` body (the block computing `ev`, `evidence`, and returning the suggestion) with:

```ts
      .map(s => {
        const sigs = s.sourceSignatures ?? (s.sourceSignature ? [s.sourceSignature] : []);
        const matched = sigs.map(sig => bySignature.get(sig)).filter((c): c is Candidate => !!c);
        const count = matched.reduce((n, c) => n + c.count, 0);
        const sessions = new Set(matched.flatMap(c => c.sessionIds)).size;
        const examples = matched.flatMap(c => c.examples).map(redact).slice(0, 5);
        return {
          id: idFor(s.payload.type === "command" ? (s.payload.commandName ?? s.name) : s.name),
          name: s.name,
          title: s.title,
          rationale: s.rationale,
          evidence: { count, sessions },
          confidence: ALLOWED_CONFIDENCE.has(s.confidence) ? s.confidence : "inferred",
          examples,
          payload: s.payload,
        };
      });
```

Add `Candidate` to the type import at the top of `detect.ts` if not already imported:

```ts
import type { Candidate, Suggestion, Confidence } from "./types.js";
```

- [ ] **Step 6: Set examples on the degrade path** — in `candidateToCommand`, add `examples` to the returned suggestion:

```ts
    confidence: c.confidence,
    examples: c.examples.map(redact).slice(0, 5),
    payload: { type: "command", commandName, body: c.examples[0] ?? c.signature },
```

- [ ] **Step 7: Run the full detect suite + typecheck**

Run: `cd cli && npx vitest run src/core/detect.test.ts && npm run typecheck`
Expected: PASS — the new tests plus all legacy `sourceSignature` tests (tolerated) stay green.

- [ ] **Step 8: Commit**

```bash
git add cli/src/core/types.ts cli/src/core/detect.ts cli/src/core/detect.test.ts
git commit -m "feat(core): merge synonymous clusters in detect, sum evidence, add examples"
```

---

### Task 3: Widen the detect window + demote the recency cap for `--all`

**Files:**
- Modify: `cli/src/core/scope.ts` (add `DEFAULT_DETECT_WINDOW`)
- Modify: `cli/src/commands/scan.ts:50,62-65` (window + cap resolution)
- Test: `cli/src/commands/scan.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DEFAULT_DETECT_WINDOW = 24` from `scope.ts`; `scan` sends up to 24 candidates to `detect` by default and disables the recency cap when `scope === "all"` unless `maxPrompts` is set.

- [ ] **Step 1: Write the failing tests** — add to `cli/src/commands/scan.test.ts` (use the existing test's dependency-injection style; `parseFn` returns crafted turns, `backend` is a stub):

```ts
it("sends up to DEFAULT_DETECT_WINDOW candidates to the llm", async () => {
  const logs: string[] = [];
  // 30 distinct prompts, each repeated 3× → 30 candidates over minCount
  const turns = Array.from({ length: 30 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) => ({ ts: `t${i}`, project: "p", role: "user" as const, text: `distinct prompt number ${i}`, sessionId: `s${j}` }))
  ).flat();
  const backend = { name: "f", available: async () => true, complete: async () => JSON.stringify({ suggestions: [] }) };
  await scan(
    { scope: "all", projectPath: process.cwd() },
    { backend, collectFn: async () => ["f"], parseFn: async () => turns, log: (m) => logs.push(m) },
  );
  expect(logs.some(l => l.includes("top 24"))).toBe(true);
});

it("does not apply the recency cap for --all", async () => {
  const logs: string[] = [];
  const turns = Array.from({ length: 20 }, (_, i) => ({ ts: `t${i}`, project: "p", role: "user" as const, text: "continue", sessionId: `s${i}` }));
  await scan(
    { scope: "all", projectPath: process.cwd(), maxPrompts: undefined },
    { backend: null, collectFn: async () => ["f"], parseFn: async () => turns, log: (m) => logs.push(m) },
  );
  expect(logs.some(l => l.includes("capped to most recent"))).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && npx vitest run src/commands/scan.test.ts -t "DEFAULT_DETECT_WINDOW"`
Expected: FAIL — log says "top 12", not "top 24".

- [ ] **Step 3: Add the constant** — in `cli/src/core/scope.ts`, add alongside the other defaults:

```ts
export const DEFAULT_DETECT_WINDOW = 24;
```

- [ ] **Step 4: Use it in `scan.ts`** — update the import and the two use sites:

```ts
import { DEFAULT_MAX_PROMPTS, DEFAULT_DETECT_WINDOW } from "../core/scope.js";
```

Replace the cap resolution (currently `const max = opts.maxPrompts ?? config.maxPrompts ?? DEFAULT_MAX_PROMPTS;`):

```ts
  const isAll = opts.scope === "all";
  const max = opts.maxPrompts ?? config.maxPrompts ?? (isAll ? 0 : DEFAULT_MAX_PROMPTS);
```

Replace the `detect` call's window (both the `limit` and the `onCap` message use `?? 12`):

```ts
  const window = opts.limit ?? DEFAULT_DETECT_WINDOW;
  const suggestions = await detect(candidates, backend, {
    limit: window,
    onCap: dropped => log(`capped to top ${window}; ${dropped} lower-frequency candidates dropped`),
  });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd cli && npx vitest run src/commands/scan.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/scope.ts cli/src/commands/scan.ts cli/src/commands/scan.test.ts
git commit -m "feat(scan): widen detect window to 24, disable recency cap for --all"
```

---

### Task 4: `core/lsh.ts` — deterministic minhash + LSH banding

**Files:**
- Create: `cli/src/core/lsh.ts`
- Test: `cli/src/core/lsh.test.ts`

**Interfaces:**
- Produces:
  - `minhash(shingles: Set<string>, numHashes?: number): number[]` — length `numHashes` (default `LSH_NUM_HASHES`).
  - `bandKeys(signature: number[], opts?: { bands?: number; rows?: number }): string[]` — length `bands` (default `LSH_BANDS`).
  - Constants `LSH_NUM_HASHES = 120`, `LSH_BANDS = 20`, `LSH_ROWS = 6` (`bands * rows === numHashes`; threshold ≈ `(1/20)^(1/6)` ≈ 0.607, matching cluster's `simThreshold` 0.6).

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/lsh.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { minhash, bandKeys, LSH_NUM_HASHES, LSH_BANDS } from "./lsh.js";

const shingle = (s: string) => new Set(s.split(""));

describe("minhash", () => {
  it("produces a signature of numHashes length", () => {
    expect(minhash(shingle("abcdef")).length).toBe(LSH_NUM_HASHES);
  });
  it("is identical for identical sets and stable across calls", () => {
    expect(minhash(shingle("abcdef"))).toEqual(minhash(shingle("abcdef")));
  });
});

describe("bandKeys", () => {
  it("produces one key per band", () => {
    expect(bandKeys(minhash(shingle("abcdef"))).length).toBe(LSH_BANDS);
  });
  it("identical sets share all band keys; disjoint sets share none", () => {
    const a = bandKeys(minhash(shingle("the quick brown fox")));
    const b = bandKeys(minhash(shingle("the quick brown fox")));
    const c = bandKeys(minhash(shingle("ZZZZZZ 9999 %%%%")));
    expect(a).toEqual(b);
    expect(a.some(k => c.includes(k))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && npx vitest run src/core/lsh.test.ts`
Expected: FAIL — module `./lsh.js` not found.

- [ ] **Step 3: Implement `core/lsh.ts`**

```ts
// Deterministic minhash + LSH banding. Pure and dependency-free so clustering
// scales near-linearly instead of comparing every candidate pair. No RNG — hash
// coefficients are derived from the index so signatures are stable across runs.

export const LSH_NUM_HASHES = 120;
export const LSH_BANDS = 20;
export const LSH_ROWS = 6; // LSH_BANDS * LSH_ROWS === LSH_NUM_HASHES

// FNV-1a 32-bit string hash.
function h32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Universal-hash coefficients, deterministic per hash index.
function coeffs(n: number): { a: number[]; b: number[] } {
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < n; i++) {
    a.push((Math.imul(i, 2) + 1) >>> 0 | 1);              // odd multiplier
    b.push((Math.imul(i, 0x85ebca77) + 0x165667b1) >>> 0);
  }
  return { a, b };
}

export function minhash(shingles: Set<string>, numHashes = LSH_NUM_HASHES): number[] {
  const { a, b } = coeffs(numHashes);
  const out = new Array<number>(numHashes).fill(0xffffffff);
  for (const sh of shingles) {
    const x = h32(sh);
    for (let i = 0; i < numHashes; i++) {
      const v = (Math.imul(a[i], x) + b[i]) >>> 0;
      if (v < out[i]) out[i] = v;
    }
  }
  return out;
}

export function bandKeys(
  signature: number[],
  opts: { bands?: number; rows?: number } = {},
): string[] {
  const bands = opts.bands ?? LSH_BANDS;
  const rows = opts.rows ?? LSH_ROWS;
  const keys: string[] = [];
  for (let band = 0; band < bands; band++) {
    const start = band * rows;
    keys.push(`${band}:${signature.slice(start, start + rows).join(",")}`);
  }
  return keys;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cli && npx vitest run src/core/lsh.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/src/core/lsh.ts cli/src/core/lsh.test.ts
git commit -m "feat(core): add deterministic minhash + LSH banding module"
```

---

### Task 5: Replace cluster's O(b²) merge with LSH banding

**Files:**
- Modify: `cli/src/core/cluster.ts` (export `trigrams`; rewrite stage-2 merge)
- Test: `cli/src/core/cluster.test.ts`

**Interfaces:**
- Consumes: `minhash`, `bandKeys` (Task 4); `Candidate.sessionIds` (Task 1).
- Produces: identical `Candidate[]` semantics (same confidence/count/sessions rules) — only which bucket pairs get compared changes. `trigrams(s: string): Set<string>` is now exported for reuse.

- [ ] **Step 1: Write the failing test** — add to the `describe("cluster")` block in `cli/src/core/cluster.test.ts`:

```ts
it("still merges an in-threshold near-duplicate hidden among many distinct prompts", () => {
  const noise: Turn[] = Array.from({ length: 200 }, (_, i) => u(`unrelated distinct prompt ${i}`, `n${i}`));
  const trio = [
    u("push and create a pull request", "s1"),
    u("push and create a pull request then", "s2"),
    u("push and create the pull request", "s3"),
  ];
  const cands = cluster([...noise, ...trio], { minCount: 3, simThreshold: 0.5 });
  expect(cands.some(c => c.count >= 3 && c.confidence === "inferred")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails or passes-by-luck** — this guards that LSH does not *miss* in-threshold pairs.

Run: `cd cli && npx vitest run src/core/cluster.test.ts -t "hidden among many"`
Expected: FAIL after Step 3's refactor is stubbed incorrectly; write Step 3 to make it PASS. (If it passes against the current O(b²) code, that is fine — it must still pass after the rewrite.)

- [ ] **Step 3: Export `trigrams`** — in `cli/src/core/cluster.ts`, change `function trigrams` to `export function trigrams` and add the import:

```ts
import { minhash, bandKeys } from "./lsh.js";
```

- [ ] **Step 4: Rewrite the stage-2 merge** — replace the entire Stage 2 block (the `const buckets = …` through the loop that builds `merged`/`fuzzyMember`) with a band-indexed version:

```ts
  // Stage 2: merge near-duplicate buckets, comparing only LSH-band-sharing hosts.
  const buckets = [...exact.values()].sort((a, b) => b.count - a.count);
  const merged: Bucket[] = [];
  const fuzzyMember: boolean[] = [];
  const bandIndex = new Map<string, number[]>(); // bandKey -> host indices

  for (const b of buckets) {
    const keys = bandKeys(minhash(trigrams(b.signature)));
    const candidateHosts = new Set<number>();
    for (const k of keys) for (const hi of bandIndex.get(k) ?? []) candidateHosts.add(hi);

    let hostIdx = -1;
    for (const hi of [...candidateHosts].sort((x, y) => x - y)) {
      if (similarity(merged[hi].signature, b.signature) >= simThreshold) { hostIdx = hi; break; }
    }

    if (hostIdx >= 0) {
      const host = merged[hostIdx];
      host.count += b.count;
      for (const s of b.sessions) host.sessions.add(s);
      for (const ex of b.examples) if (host.examples.length < 5) host.examples.push(ex);
      fuzzyMember[hostIdx] = true;
    } else {
      merged.push({ ...b, sessions: new Set(b.sessions) });
      const idx = merged.length - 1;
      fuzzyMember[idx] = false;
      for (const k of keys) {
        const arr = bandIndex.get(k) ?? [];
        arr.push(idx);
        bandIndex.set(k, arr);
      }
    }
  }
```

Leave the final `merged.forEach((b, i) => {…})` candidate-building loop (with `sessionIds` from Task 1) unchanged.

- [ ] **Step 5: Run the full cluster suite + typecheck**

Run: `cd cli && npx vitest run src/core/cluster.test.ts && npm run typecheck`
Expected: PASS — including the pre-existing "merges near-duplicates into an inferred candidate" and "groups exact repeats" tests.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/cluster.ts cli/src/core/cluster.test.ts
git commit -m "perf(core): replace O(b^2) cluster merge with LSH banding"
```

---

### Task 6: `gradient stats` — coverage + top patterns

**Files:**
- Create: `cli/src/commands/stats.ts`
- Modify: `cli/src/cli.ts` (dispatch + HELP)
- Test: `cli/src/commands/stats.test.ts`

**Interfaces:**
- Consumes: `loadSuggestions` (from `./apply.js`), `loadManifest` (from `../core/manifest.js`).
- Produces:
  - `type StatPattern = { name: string; count: number; sessions: number; confidence: Confidence; covered: boolean }`
  - `type StatsReport = { total: number; covered: number; coveragePct: number; patterns: StatPattern[] }`
  - `stats(projectDir: string): Promise<StatsReport>` — patterns sorted by `count` desc; `covered` = a manifest entry exists with the same `suggestionId`; `coveragePct` = `round(covered / total * 100)` (0 when `total === 0`).

- [ ] **Step 1: Write the failing test** — create `cli/src/commands/stats.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stats } from "./stats.js";

async function seed(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-stats-"));
  await mkdir(join(dir, ".gradient"), { recursive: true });
  const suggestions = [
    { id: "aaa", name: "ship", title: "Ship", rationale: "r", evidence: { count: 9, sessions: 3 }, confidence: "high", payload: { type: "command", commandName: "ship", body: "x" } },
    { id: "bbb", name: "plan", title: "Plan", rationale: "r", evidence: { count: 4, sessions: 2 }, confidence: "inferred", payload: { type: "command", commandName: "plan", body: "y" } },
  ];
  const manifest = [{ name: "ship", type: "command", path: ".claude/commands/ship.md", createdAt: "2026-07-01", suggestionId: "aaa" }];
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify(suggestions));
  await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify(manifest));
  return dir;
}

describe("stats", () => {
  it("reports coverage and top patterns sorted by frequency", async () => {
    const report = await stats(await seed());
    expect(report.total).toBe(2);
    expect(report.covered).toBe(1);
    expect(report.coveragePct).toBe(50);
    expect(report.patterns[0].name).toBe("ship");
    expect(report.patterns[0].covered).toBe(true);
    expect(report.patterns[1].covered).toBe(false);
  });

  it("reports zeros with no cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-stats-empty-"));
    const report = await stats(dir);
    expect(report).toEqual({ total: 0, covered: 0, coveragePct: 0, patterns: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && npx vitest run src/commands/stats.test.ts`
Expected: FAIL — module `./stats.js` not found.

- [ ] **Step 3: Implement `commands/stats.ts`**

```ts
import type { Confidence } from "../core/types.js";
import { loadManifest } from "../core/manifest.js";
import { loadSuggestions } from "./apply.js";

export interface StatPattern {
  name: string;
  count: number;
  sessions: number;
  confidence: Confidence;
  covered: boolean;
}

export interface StatsReport {
  total: number;
  covered: number;
  coveragePct: number;
  patterns: StatPattern[];
}

export async function stats(projectDir: string): Promise<StatsReport> {
  const suggestions = await loadSuggestions(projectDir);
  const manifest = await loadManifest(projectDir);
  const coveredIds = new Set(manifest.map(m => m.suggestionId));

  const patterns: StatPattern[] = suggestions
    .map(s => ({
      name: s.name,
      count: s.evidence.count,
      sessions: s.evidence.sessions,
      confidence: s.confidence,
      covered: coveredIds.has(s.id),
    }))
    .sort((a, b) => b.count - a.count);

  const total = patterns.length;
  const covered = patterns.filter(p => p.covered).length;
  const coveragePct = total === 0 ? 0 : Math.round((covered / total) * 100);
  return { total, covered, coveragePct, patterns };
}
```

- [ ] **Step 4: Wire into the CLI** — in `cli/src/cli.ts`, add the import and a `case`:

```ts
import { stats } from "./commands/stats.js";
```

```ts
      case "stats": {
        log(banner(VERSION));
        const r = await stats(projectDir);
        log(c.dim(`coverage: ${r.covered}/${r.total} patterns automated (${r.coveragePct}%)`));
        for (const p of r.patterns) {
          log(`  ${confidenceChip(p.confidence)} ${c.bold(p.name)}  ${c.dim(`(seen ${p.count}× · ${p.sessions} sessions)`)}  ${p.covered ? c.ok("✓ automated") : c.muted("—")}`);
        }
        return 0;
      }
```

Add a line to the `HELP` string:

```
  gradient stats                show your most-repeated patterns + coverage
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd cli && npx vitest run src/commands/stats.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/stats.ts cli/src/cli.ts cli/src/commands/stats.test.ts
git commit -m "feat(cli): add gradient stats (coverage + top patterns)"
```

---

### Task 7: `gradient explain <id|name>` — evidence behind a suggestion

**Files:**
- Create: `cli/src/commands/explain.ts`
- Modify: `cli/src/cli.ts` (dispatch + HELP)
- Test: `cli/src/commands/explain.test.ts`

**Interfaces:**
- Consumes: `loadSuggestions` (from `./apply.js`); `Suggestion.examples` (Task 2).
- Produces: `explain(projectDir: string, idOrName: string): Promise<Suggestion | undefined>` — matches by `id` or `name`, `undefined` if absent.

- [ ] **Step 1: Write the failing test** — create `cli/src/commands/explain.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explain } from "./explain.js";

async function seed(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-explain-"));
  await mkdir(join(dir, ".gradient"), { recursive: true });
  const suggestions = [{
    id: "aaa", name: "ship", title: "Ship", rationale: "Repeated 9× across 3 sessions.",
    evidence: { count: 9, sessions: 3 }, confidence: "high",
    examples: ["push and open a PR", "push then open pr"],
    payload: { type: "command", commandName: "ship", body: "x" },
  }];
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify(suggestions));
  return dir;
}

describe("explain", () => {
  it("finds a suggestion by name", async () => {
    const s = await explain(await seed(), "ship");
    expect(s?.evidence.count).toBe(9);
    expect(s?.examples?.length).toBe(2);
  });
  it("finds a suggestion by id", async () => {
    expect((await explain(await seed(), "aaa"))?.name).toBe("ship");
  });
  it("returns undefined when not found", async () => {
    expect(await explain(await seed(), "nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && npx vitest run src/commands/explain.test.ts`
Expected: FAIL — module `./explain.js` not found.

- [ ] **Step 3: Implement `commands/explain.ts`**

```ts
import type { Suggestion } from "../core/types.js";
import { loadSuggestions } from "./apply.js";

export async function explain(projectDir: string, idOrName: string): Promise<Suggestion | undefined> {
  const all = await loadSuggestions(projectDir);
  return all.find(s => s.id === idOrName || s.name === idOrName);
}
```

- [ ] **Step 4: Wire into the CLI** — in `cli/src/cli.ts`, add the import and a `case`:

```ts
import { explain } from "./commands/explain.js";
```

```ts
      case "explain": {
        const s = await explain(projectDir, positionals[0] ?? "");
        if (!s) {
          log(c.coral(`no suggestion matching: ${positionals[0] ?? "(none given)"}`));
          return 1;
        }
        log(`${confidenceChip(s.confidence)} ${c.bold(s.name)}  ${c.muted(s.title)}`);
        log(c.dim(s.rationale));
        log(c.dim(`seen ${s.evidence.count}× across ${s.evidence.sessions} sessions`));
        for (const ex of s.examples ?? []) log(`  ${c.muted("·")} ${ex}`);
        return 0;
      }
```

Add a line to the `HELP` string:

```
  gradient explain <id|name>    show the evidence behind a suggestion
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd cli && npx vitest run src/commands/explain.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/explain.ts cli/src/cli.ts cli/src/commands/explain.test.ts
git commit -m "feat(cli): add gradient explain <id|name>"
```

---

### Task 8: `gradient scan --detach` — non-blocking background scan

**Files:**
- Create: `cli/src/core/spawn.ts`
- Modify: `cli/src/cli.ts` (add `--detach` option + branch)
- Test: `cli/src/core/spawn.test.ts`

**Interfaces:**
- Produces: `spawnDetached(args: string[], projectDir: string, deps?: SpawnDeps): void` where `SpawnDeps = { spawn?: SpawnFn; openLog?: (path: string) => number }`. Launches `process.execPath <cliEntry> <args…>` detached, piping stdout+stderr to `<projectDir>/.gradient/last-scan.log`, then `unref()`s. Returns immediately.

- [ ] **Step 1: Write the failing test** — create `cli/src/core/spawn.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { spawnDetached } from "./spawn.js";

describe("spawnDetached", () => {
  it("spawns the cli detached with the given args and unrefs", () => {
    const calls: any[] = [];
    let unreffed = false;
    const fakeChild = { unref: () => { unreffed = true; } };
    const spawn = ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts });
      return fakeChild;
    }) as any;
    spawnDetached(["scan", "--all"], "/tmp/proj", { spawn, openLog: () => 7 });
    expect(calls.length).toBe(1);
    expect(calls[0].args).toContain("scan");
    expect(calls[0].args).toContain("--all");
    expect(calls[0].opts.detached).toBe(true);
    expect(calls[0].opts.stdio).toEqual(["ignore", 7, 7]);
    expect(unreffed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && npx vitest run src/core/spawn.test.ts`
Expected: FAIL — module `./spawn.js` not found.

- [ ] **Step 3: Implement `core/spawn.ts`**

```ts
import { spawn as realSpawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { gradientDir } from "./manifest.js";

type SpawnFn = typeof realSpawn;

export interface SpawnDeps {
  spawn?: SpawnFn;
  openLog?: (path: string) => number;
}

function defaultOpenLog(path: string): number {
  mkdirSync(join(path, ".."), { recursive: true });
  return openSync(path, "a");
}

/**
 * Launch the gradient CLI in the background (detached) so a session-start hook
 * returns immediately. stdout/stderr go to .gradient/last-scan.log so a failed
 * background run is still diagnosable (never silent).
 */
export function spawnDetached(args: string[], projectDir: string, deps: SpawnDeps = {}): void {
  const spawn = deps.spawn ?? realSpawn;
  const logPath = join(gradientDir(projectDir), "last-scan.log");
  const fd = (deps.openLog ?? defaultOpenLog)(logPath);
  const child = spawn(process.execPath, [process.argv[1], ...args], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
}
```

- [ ] **Step 4: Wire `--detach` into the CLI** — in `cli/src/cli.ts`:

Add the option to `parseArgs`:

```ts
      detach: { type: "boolean" },
```

Add the import:

```ts
import { spawnDetached } from "./core/spawn.js";
```

At the very top of the `case "scan":` block (before `log(banner(VERSION))`), short-circuit when detached:

```ts
      case "scan": {
        if (flags.detach) {
          const passthrough = argv.slice(1).filter(a => a !== "--detach");
          spawnDetached(["scan", ...passthrough], projectDir);
          return 0;
        }
        log(banner(VERSION));
        // …existing scan body…
      }
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd cli && npx vitest run src/core/spawn.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/core/spawn.ts cli/src/cli.ts cli/src/core/spawn.test.ts
git commit -m "feat(scan): add --detach for non-blocking background scans"
```

---

### Task 9: `core/settings.ts` — idempotent hook merge into `.claude/settings.json`

**Files:**
- Create: `cli/src/core/settings.ts`
- Modify: `cli/src/core/validate.ts:3` (allow `scan` subcommand)
- Test: `cli/src/core/settings.test.ts`
- Test: `cli/src/core/validate.test.ts` (scan is now runnable)

**Interfaces:**
- Produces:
  - `settingsPath(projectDir: string): string` → `<projectDir>/.claude/settings.json`
  - `mergeHookIntoSettings(existing: Record<string, any>, event: string, command: string): Record<string, any>` — adds the `{type:"command",command}` hook under `hooks[event]` only if that exact command is not already present (idempotent); preserves everything else.
  - `installHook(projectDir: string, event: string, command: string): Promise<string>` — read-merge-write `settings.json` inside `<projectDir>/.claude` (guarded by `assertInside`); returns the written path.
- Also: `validate.ts` `KNOWN_SUBCOMMANDS` now includes `"scan"`.

- [ ] **Step 1: Write the failing tests** — create `cli/src/core/settings.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeHookIntoSettings, installHook } from "./settings.js";

describe("mergeHookIntoSettings", () => {
  it("adds a hook, preserving unrelated settings", () => {
    const out = mergeHookIntoSettings({ model: "x" }, "SessionStart", "gradient scan --detach");
    expect(out.model).toBe("x");
    expect(out.hooks.SessionStart[0].hooks[0].command).toBe("gradient scan --detach");
  });
  it("is idempotent for the same command", () => {
    const once = mergeHookIntoSettings({}, "SessionStart", "gradient scan --detach");
    const twice = mergeHookIntoSettings(once, "SessionStart", "gradient scan --detach");
    expect(twice.hooks.SessionStart.length).toBe(1);
  });
});

describe("installHook", () => {
  it("writes the hook into project .claude/settings.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-settings-"));
    const p = await installHook(dir, "SessionStart", "gradient scan --detach");
    const written = JSON.parse(await readFile(p, "utf8"));
    expect(written.hooks.SessionStart[0].hooks[0].command).toBe("gradient scan --detach");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cli && npx vitest run src/core/settings.test.ts`
Expected: FAIL — module `./settings.js` not found.

- [ ] **Step 3: Implement `core/settings.ts`**

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { assertInside } from "./security.js";

export function settingsPath(projectDir: string): string {
  return join(projectDir, ".claude", "settings.json");
}

interface HookGroup { hooks: { type: string; command: string }[] }

export function mergeHookIntoSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
): Record<string, any> {
  const out = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  const groups: HookGroup[] = Array.isArray(out.hooks[event]) ? [...out.hooks[event]] : [];
  const already = groups.some(g => g.hooks?.some(h => h.command === command));
  if (!already) groups.push({ hooks: [{ type: "command", command }] });
  out.hooks[event] = groups;
  return out;
}

export async function installHook(projectDir: string, event: string, command: string): Promise<string> {
  const path = settingsPath(projectDir);
  assertInside(join(projectDir, ".claude"), path);
  let existing: Record<string, any> = {};
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch {
    existing = {};
  }
  const merged = mergeHookIntoSettings(existing, event, command);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(merged, null, 2));
  return path;
}
```

- [ ] **Step 4: Allow the `scan` subcommand** — in `cli/src/core/validate.ts`, extend the set:

```ts
export const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set(["checkpoint", "scan"]);
```

- [ ] **Step 5: Add a validate test** — append to `cli/src/core/validate.test.ts`:

```ts
it("treats a SessionStart→scan hook as runnable", () => {
  const s: any = { id: "x", name: "n", title: "t", rationale: "r", confidence: "high",
    payload: { type: "hook", event: "SessionStart", subcommand: "scan", description: "d" } };
  expect(() => assertHookRunnable(s)).not.toThrow();
});
```

(Ensure `assertHookRunnable` is imported in that test file's import line alongside `validateSuggestion`.)

- [ ] **Step 6: Run tests + typecheck**

Run: `cd cli && npx vitest run src/core/settings.test.ts src/core/validate.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cli/src/core/settings.ts cli/src/core/validate.ts cli/src/core/validate.test.ts cli/src/core/settings.test.ts
git commit -m "feat(core): idempotent hook merge into .claude/settings.json; allow scan subcommand"
```

---

### Task 10: Opt-in session-start scan — `init --session-scan`

**Files:**
- Modify: `cli/src/core/types.ts` (Config: `scanOnSessionStart`)
- Modify: `cli/src/commands/init.ts` (accept `sessionScan`, set flag, install hook)
- Modify: `cli/src/cli.ts` (`--session-scan` option → init; report install)
- Test: `cli/src/commands/init.test.ts`

**Interfaces:**
- Consumes: `installHook` (Task 9); `saveConfig`/`loadConfig`.
- Produces: `init(opts: { installSkill: boolean; sessionScan?: boolean; home?: string; projectDir?: string }, deps?)` — when `sessionScan`, persists `scanOnSessionStart: true` and installs a `SessionStart → gradient scan --detach` hook into `projectDir`'s `.claude/settings.json`. `InitResult` gains `sessionScanInstalled: boolean`.

- [ ] **Step 1: Write the failing test** — add to `cli/src/commands/init.test.ts` (follow the file's existing temp-dir + `home`/`installSkill:false` pattern):

```ts
it("installs a SessionStart scan hook and sets the config flag when sessionScan is on", async () => {
  const home = await mkdtemp(join(tmpdir(), "grad-init-home-"));
  const projectDir = await mkdtemp(join(tmpdir(), "grad-init-proj-"));
  const r = await init(
    { installSkill: false, sessionScan: true, home, projectDir },
    { backend: null },
  );
  expect(r.sessionScanInstalled).toBe(true);
  const cfg = JSON.parse(await readFile(join(home, ".config", "gradient", "config.json"), "utf8"));
  expect(cfg.scanOnSessionStart).toBe(true);
  const settings = JSON.parse(await readFile(join(projectDir, ".claude", "settings.json"), "utf8"));
  expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("gradient scan --detach");
});
```

Ensure the test file imports `readFile`, `mkdtemp`, `tmpdir`, `join` (add any missing to its existing imports).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd cli && npx vitest run src/commands/init.test.ts -t "SessionStart scan hook"`
Expected: FAIL — `sessionScan` is ignored; `r.sessionScanInstalled` is `undefined`.

- [ ] **Step 3: Add the config field** — in `cli/src/core/types.ts`, add to `Config`:

```ts
  /** When true, a SessionStart hook runs `gradient scan --detach`. */
  scanOnSessionStart?: boolean;
```

- [ ] **Step 4: Extend `init`** — in `cli/src/commands/init.ts`:

Add imports:

```ts
import { installHook } from "../core/settings.js";
```

Update the signature and `InitResult`:

```ts
export interface InitResult {
  backend: string;
  configPath: string;
  skillInstalled: boolean;
  sessionScanInstalled: boolean;
}

export async function init(
  opts: { installSkill: boolean; sessionScan?: boolean; home?: string; projectDir?: string },
  deps: { backend?: LLMBackend | null; skillSource?: string } = {},
): Promise<InitResult> {
```

Build config with the flag and install the hook (place after the existing `saveConfig` call — replace that call so the flag is included):

```ts
  const config: Config = backend ? { backend: backend.name as Config["backend"] } : {};
  if (opts.sessionScan) config.scanOnSessionStart = true;
  await saveConfig(config, home);

  let sessionScanInstalled = false;
  if (opts.sessionScan) {
    await installHook(opts.projectDir ?? process.cwd(), "SessionStart", "gradient scan --detach");
    sessionScanInstalled = true;
  }
```

Return the new field:

```ts
  return { backend: backendName, configPath: join(home, ".config/gradient/config.json"), skillInstalled, sessionScanInstalled };
```

- [ ] **Step 5: Wire the flag into the CLI** — in `cli/src/cli.ts`:

Add to `parseArgs` options:

```ts
      "session-scan": { type: "boolean" },
```

Pass it through and report it in the `case "init":` block:

```ts
      case "init": {
        const r = await init({ installSkill: !flags["no-skill"], sessionScan: !!flags["session-scan"], projectDir });
        log(banner(VERSION));
        log(
          `${c.muted("backend:")} ${r.backend}\n${c.muted("config:")} ${r.configPath}\n${c.muted("skill installed:")} ${r.skillInstalled}\n${c.muted("session-start scan:")} ${r.sessionScanInstalled}`,
        );
        return 0;
      }
```

Add an `init` usage line to `HELP`:

```
  gradient init --session-scan  also run a scan at the start of each session
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd cli && npx vitest run src/commands/init.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Full suite green**

Run: `cd cli && npx vitest run && npm run typecheck`
Expected: PASS — entire suite.

- [ ] **Step 8: Commit**

```bash
git add cli/src/core/types.ts cli/src/commands/init.ts cli/src/cli.ts cli/src/commands/init.test.ts
git commit -m "feat(init): opt-in session-start scan via --session-scan"
```

---

## Self-Review

**Spec coverage:**
- §3.1 Semantic dedup → Tasks 1 (sessionIds), 2 (merge + examples), 3 (widened window). ✓
- §3.2 stats + explain → Tasks 6, 7. ✓
- §3.3 Opt-in session-start scan → Tasks 8 (`--detach`), 9 (settings merge + allowlist), 10 (`init --session-scan`, config flag). ✓
- §3.4 `scan --all` scalability → Tasks 4 (lsh), 5 (cluster rewrite), 3 (cap demotion). ✓
- §4 data-model deltas → `Config.scanOnSessionStart` (T10), `Candidate.sessionIds` (T1), `sourceSignatures[]` (T2), plus the specced refinement `Suggestion.examples` (T2). ✓
- §6 guardrails → detached failures logged to `last-scan.log` (T8); no-broken-hooks via `KNOWN_SUBCOMMANDS` (T9); friendly empty-cache in stats/explain (T6/T7). ✓
- §9 code removed → O(b²) loop deleted (T5), singular `sourceSignature` mapping replaced (T2), `capByRecency` demoted not deleted (T3). ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N" — every code and test step is concrete. Minhash params are pinned (120/20/6). ✓

**Type consistency:** `sessionIds: string[]` (T1) consumed in T2; `DEFAULT_DETECT_WINDOW` (T3) named identically at definition/use; `spawnDetached` / `installHook` / `mergeHookIntoSettings` / `stats` / `explain` signatures match between their producing task and their CLI/consumer call sites. `Suggestion.examples` defined T2, read T7. `InitResult.sessionScanInstalled` defined + returned + printed in T10. ✓

**Ordering:** T1→T2 (sessionIds before union), T4→T5 (lsh before cluster), T2→T7 (examples before explain). Session-start tasks (8–10) are independent and safely last.
