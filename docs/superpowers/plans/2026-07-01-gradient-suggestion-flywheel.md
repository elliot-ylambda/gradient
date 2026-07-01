# gradient — Tailored Suggestions & Feedback Flywheel: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec `docs/superpowers/specs/2026-07-01-gradient-suggestion-flywheel-design.md` — leverage-ranked suggestions, temporal loop/hook evidence, corrections→CLAUDE.md rules, and the dismissal/usage/surfacing flywheel.

**Architecture:** Everything extends the existing `scan` pipeline (`collect → parse → filter → cap → cluster → detect → validate → cache`) plus the CLI commands around it. New pure core modules (`temporal`, `leverage`, `classify`, `corrections`, `claudeMd`, `dismiss`, `usage`) slot between existing stages; two new commands (`session-start`, the bare-invocation mirror) reuse them. No new subsystem, no new dependency.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest 2, zero new runtime deps.

## Global Constraints

- Branch: create `spec/suggestion-flywheel` off `main` before Task 1; commit per task step.
- All commands below run from `/Users/ellioteckholm/projects/gradient/cli`.
- House rules (from v1/Spec 1, still binding): every string sent to an LLM passes `redact()` first; no silent failures (background paths log to `.gradient/last-scan.log`); emitted hooks call a `gradient` subcommand, never inline shell; never rewrite a file that failed to parse (corrupt-settings precedent, `settings.ts:31`); writes stay inside `.claude/` or the managed CLAUDE.md block.
- Tests: co-located `*.test.ts`, vitest `describe/it/expect`, injected deps, no network, no real `claude`.
- Full gate per task: `npm test && npm run typecheck` must pass before each commit.
- **Spec refinement (deliberate):** `Suggestion.evidence.estMinutesSavedPerMonth`, `Suggestion.sourceSignatures`, and `Suggestion.evidence.temporal` are **optional** fields (spec §4 sketched required) so pre-existing `suggestions.json` caches and existing test fixtures stay valid; all display sites use `?? 0` / conditional print.

---

### Task 1: Candidate occurrences + memberSignatures (cluster plumbing)

**Files:**
- Modify: `src/core/types.ts:17-25` (Candidate)
- Modify: `src/core/cluster.ts:24-95`
- Test: `src/core/cluster.test.ts`
- Modify: `src/core/detect.test.ts:5-6, 48, 104-105, 129` (Candidate fixtures gain the new required fields)

**Interfaces:**
- Consumes: existing `Bucket`/`Candidate` internals in `cluster.ts`.
- Produces: `Candidate.occurrences: { ts: string; sessionId: string }[]` (one entry per occurrence, unioned on merge) and `Candidate.memberSignatures: string[]` (host signature + every absorbed near-duplicate signature). Both **required** on `Candidate`. Later tasks (2, 4, 5) rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/cluster.test.ts` inside `describe("cluster", ...)`:

```ts
  it("records one occurrence per turn with ts and sessionId", () => {
    const turns = [
      { ts: "2026-06-01T10:00:00Z", project: "p", role: "user" as const, text: "continue", sessionId: "s1" },
      { ts: "2026-06-01T10:05:00Z", project: "p", role: "user" as const, text: "continue", sessionId: "s1" },
      { ts: "2026-06-02T09:00:00Z", project: "p", role: "user" as const, text: "continue", sessionId: "s2" },
    ];
    const top = cluster(turns, { minCount: 3 })[0];
    expect(top.occurrences).toEqual([
      { ts: "2026-06-01T10:00:00Z", sessionId: "s1" },
      { ts: "2026-06-01T10:05:00Z", sessionId: "s1" },
      { ts: "2026-06-02T09:00:00Z", sessionId: "s2" },
    ]);
    expect(top.memberSignatures).toEqual(["continue"]);
  });
  it("unions occurrences and memberSignatures across a fuzzy merge", () => {
    const turns = [
      u("push and create a pull request", "s1"),
      u("push and create a pull request then", "s2"),
      u("push and create the pull request", "s3"),
    ];
    const cands = cluster(turns, { minCount: 3, simThreshold: 0.5 });
    const merged = cands.find(c => c.count >= 3 && c.confidence === "inferred")!;
    expect(merged.occurrences.length).toBe(3);
    expect(merged.memberSignatures.length).toBeGreaterThanOrEqual(2);
    expect(merged.memberSignatures).toContain("push and create a pull request");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/cluster.test.ts`
Expected: FAIL — `occurrences`/`memberSignatures` are `undefined`.

- [ ] **Step 3: Implement**

`src/core/types.ts` — extend `Candidate` (after `sessionIds`):

```ts
export interface Candidate {
  kind: ArtifactType | "unknown";
  signature: string;     // normalized key the cluster grouped on
  examples: string[];    // representative raw prompts
  count: number;
  sessions: number;
  sessionIds: string[];  // distinct session ids (for exact union when clusters merge)
  /** One entry per occurrence, in encounter order; unioned when clusters merge. */
  occurrences: { ts: string; sessionId: string }[];
  /** Host signature plus every absorbed near-duplicate signature (for turn→cluster membership). */
  memberSignatures: string[];
  confidence: Confidence;
}
```

`src/core/cluster.ts` — thread the two fields through `Bucket`:

```ts
interface Bucket {
  signature: string; examples: string[]; count: number; sessions: Set<string>;
  occurrences: { ts: string; sessionId: string }[];
  memberSignatures: string[];
}
```

Stage 1 (exact buckets), in the `for (const t of turns)` loop:

```ts
    if (!b) {
      b = { signature: norm, examples: [], count: 0, sessions: new Set(), occurrences: [], memberSignatures: [norm] };
      exact.set(norm, b);
    }
    b.count++;
    b.sessions.add(t.sessionId);
    b.occurrences.push({ ts: t.ts, sessionId: t.sessionId });
    if (b.examples.length < 5) b.examples.push(t.text);
```

Stage 2 merge (inside `if (hostIdx >= 0)`):

```ts
      const host = merged[hostIdx];
      host.count += b.count;
      for (const s of b.sessions) host.sessions.add(s);
      host.occurrences.push(...b.occurrences);
      host.memberSignatures.push(...b.memberSignatures);
      for (const ex of b.examples) if (host.examples.length < 5) host.examples.push(ex);
      fuzzyMember[hostIdx] = true;
```

(Non-merge branch `merged.push({ ...b, sessions: new Set(b.sessions) })` needs no change — spread copies the arrays' references, which is fine since source buckets are never reused; to be safe copy them: `merged.push({ ...b, sessions: new Set(b.sessions), occurrences: [...b.occurrences], memberSignatures: [...b.memberSignatures] })`.)

Candidate emission (in `merged.forEach`):

```ts
    candidates.push({
      kind: "unknown",
      signature: b.signature,
      examples: b.examples,
      count: b.count,
      sessions: b.sessions.size,
      sessionIds: [...b.sessions],
      occurrences: b.occurrences,
      memberSignatures: b.memberSignatures,
      confidence,
    });
```

Update `src/core/detect.test.ts` fixtures (compilation gate). The `cand` helper (line 5):

```ts
const cand = (signature: string, count: number, confidence: any = "high"): Candidate =>
  ({ kind: "unknown", signature, examples: [signature], count, sessions: count, sessionIds: ["s"],
     occurrences: Array.from({ length: count }, (_, i) => ({ ts: `2026-06-0${(i % 7) + 1}T10:00:00Z`, sessionId: "s" })),
     memberSignatures: [signature], confidence });
```

The two inline `const c: Candidate` literals (redaction test ~line 48, examples test ~line 129) each gain:

```ts
      occurrences: [{ ts: "2026-06-01T00:00:00Z", sessionId: "s1" }],
      memberSignatures: ["deploy with token sk-ant-abc123def"],
```

and the lgtm/looks-good merge test's two literals (~lines 104-105) gain `occurrences: [{ ts: "2026-06-01T00:00:00Z", sessionId: "s1" }], memberSignatures: ["lgtm"]` (resp. `["looks good"]`, sessionId `"s2"`).

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `npx vitest run src/core/cluster.test.ts src/core/detect.test.ts && npm run typecheck`
Expected: PASS. Then full suite: `npm test` — PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): carry per-occurrence timestamps and member signatures through clustering"
```

---

### Task 2: `core/temporal.ts` — temporal features per candidate

**Files:**
- Create: `src/core/temporal.ts`
- Modify: `src/core/types.ts` (TemporalFeatures + `Candidate.temporal?`)
- Modify: `src/commands/scan.ts:57` (annotate after cluster)
- Test: `src/core/temporal.test.ts`

**Interfaces:**
- Consumes: `Candidate.occurrences`, `Candidate.memberSignatures` (Task 1); `normalize` from `cluster.js`.
- Produces: `interface TemporalFeatures { maxRunLength: number; runSessions: number; medianGapMinutes: number; distinctDays: number; spanDays: number }` in types.ts; `annotateTemporal(prompts: Turn[], candidates: Candidate[]): void` (sets `c.temporal` on every candidate); `spanDays(occurrences: { ts: string }[]): number` (exported — Task 4 imports it).

- [ ] **Step 1: Write the failing tests**

Create `src/core/temporal.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { annotateTemporal, spanDays } from "./temporal.js";
import { cluster } from "./cluster.js";
import type { Turn } from "./types.js";

const u = (text: string, ts: string, sessionId = "s1"): Turn =>
  ({ ts, project: "p", role: "user", text, sessionId });

describe("spanDays", () => {
  it("measures the span between first and last occurrence in days", () => {
    expect(spanDays([{ ts: "2026-06-01T00:00:00Z" }, { ts: "2026-06-15T00:00:00Z" }])).toBe(14);
  });
  it("is 0 for a single or empty occurrence list", () => {
    expect(spanDays([{ ts: "2026-06-01T00:00:00Z" }])).toBe(0);
    expect(spanDays([])).toBe(0);
  });
});

describe("annotateTemporal", () => {
  it("computes run lengths for consecutive same-cluster prompts within a session", () => {
    const turns = [
      u("continue", "2026-06-01T10:00:00Z", "s1"),
      u("continue", "2026-06-01T10:05:00Z", "s1"),
      u("continue", "2026-06-01T10:10:00Z", "s1"),
      u("fix the header", "2026-06-01T10:15:00Z", "s1"),
      u("continue", "2026-06-01T10:20:00Z", "s1"),   // run broken by unrelated prompt
      u("continue", "2026-06-02T09:00:00Z", "s2"),
      u("continue", "2026-06-02T09:01:00Z", "s2"),
    ];
    const cands = cluster(turns, { minCount: 3 });
    annotateTemporal(turns, cands);
    const cont = cands.find(c => c.signature === "continue")!;
    expect(cont.temporal!.maxRunLength).toBe(3);
    expect(cont.temporal!.runSessions).toBe(2);   // s1 and s2 both contain a run ≥ 2
    expect(cont.temporal!.distinctDays).toBe(2);
  });
  it("computes the median gap in minutes across occurrences", () => {
    const turns = [
      u("check the deploy", "2026-06-01T09:00:00Z", "s1"),
      u("check the deploy", "2026-06-01T09:10:00Z", "s1"),
      u("check the deploy", "2026-06-01T09:30:00Z", "s1"),
    ];
    const cands = cluster(turns, { minCount: 3 });
    annotateTemporal(turns, cands);
    expect(cands[0].temporal!.medianGapMinutes).toBe(15); // gaps 10 and 20 → median 15
  });
  it("annotates every candidate, even single-run ones", () => {
    const turns = [
      u("review the spec", "2026-06-01T09:00:00Z", "s1"),
      u("review the spec", "2026-06-02T09:00:00Z", "s2"),
      u("review the spec", "2026-06-03T09:00:00Z", "s3"),
    ];
    const cands = cluster(turns, { minCount: 3 });
    annotateTemporal(turns, cands);
    expect(cands[0].temporal).toMatchObject({ maxRunLength: 1, runSessions: 0, distinctDays: 3, spanDays: 2 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/temporal.test.ts`
Expected: FAIL — module `./temporal.js` not found.

- [ ] **Step 3: Implement**

`src/core/types.ts` — add above `Candidate` and reference from it:

```ts
/** Local-only temporal evidence per cluster (core/temporal.ts). */
export interface TemporalFeatures {
  maxRunLength: number;      // longest streak of consecutive user prompts in one session, all in this cluster
  runSessions: number;       // sessions containing a run of length ≥ 2
  medianGapMinutes: number;  // median gap between successive occurrences
  distinctDays: number;
  spanDays: number;
}
```

and on `Candidate` (after `memberSignatures`): `temporal?: TemporalFeatures;`

Create `src/core/temporal.ts`:

```ts
import type { Turn, Candidate } from "./types.js";
import { normalize } from "./cluster.js";

/** Whole days between first and last occurrence, one decimal. */
export function spanDays(occurrences: { ts: string }[]): number {
  const ts = occurrences.map(o => Date.parse(o.ts)).filter(Number.isFinite).sort((a, b) => a - b);
  return ts.length > 1 ? Math.round(((ts[ts.length - 1] - ts[0]) / 86_400_000) * 10) / 10 : 0;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Sets c.temporal on every candidate. A "run" is a streak of consecutive user
 * prompts within one session that all belong to the same cluster (any
 * non-member prompt in between breaks the run).
 */
export function annotateTemporal(prompts: Turn[], candidates: Candidate[]): void {
  const byMember = new Map<string, number>();
  candidates.forEach((c, i) => { for (const sig of c.memberSignatures) byMember.set(sig, i); });

  const maxRun = new Array<number>(candidates.length).fill(1);
  const runSessions: Set<string>[] = candidates.map(() => new Set());

  const bySession = new Map<string, Turn[]>();
  for (const t of prompts) {
    if (!t.text) continue;
    const arr = bySession.get(t.sessionId) ?? [];
    arr.push(t);
    bySession.set(t.sessionId, arr);
  }
  for (const [sessionId, turns] of bySession) {
    const ordered = [...turns].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let prev = -1, run = 0;
    for (const t of ordered) {
      const idx = byMember.get(normalize(t.text!)) ?? -1;
      run = idx >= 0 && idx === prev ? run + 1 : 1;
      if (idx >= 0) {
        if (run > maxRun[idx]) maxRun[idx] = run;
        if (run >= 2) runSessions[idx].add(sessionId);
      }
      prev = idx;
    }
  }

  candidates.forEach((c, i) => {
    const ts = c.occurrences.map(o => Date.parse(o.ts)).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let j = 1; j < ts.length; j++) gaps.push((ts[j] - ts[j - 1]) / 60_000);
    c.temporal = {
      maxRunLength: maxRun[i],
      runSessions: runSessions[i].size,
      medianGapMinutes: Math.round(median(gaps)),
      distinctDays: new Set(c.occurrences.map(o => o.ts.slice(0, 10))).size,
      spanDays: spanDays(c.occurrences),
    };
  });
}
```

`src/commands/scan.ts` — import and call after clustering (line 57):

```ts
import { annotateTemporal } from "../core/temporal.js";
// …
  const candidates = cluster(kept);
  annotateTemporal(kept, candidates);
```

- [ ] **Step 4: Run tests + full gate**

Run: `npx vitest run src/core/temporal.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): temporal features per cluster (run length, cadence, day spread)"
```

---

### Task 3: CommandEvents — parse `<command-name>` turns instead of filtering them

**Files:**
- Modify: `src/core/types.ts` (CommandEvent)
- Modify: `src/core/parse.ts`
- Modify: `src/core/filter.ts:4` (delete the `^<command-(name|message|args)` pattern)
- Modify: `src/commands/scan.ts` (`ScanDeps.parseFn` now returns `ParsedTranscript`; collect events)
- Test: `src/core/parse.test.ts`, `src/core/filter.test.ts:12` (assertion moves), `src/commands/scan.test.ts:17,29,52` (stub shape)

**Interfaces:**
- Consumes: raw transcript JSONL lines.
- Produces: `interface CommandEvent { ts: string; sessionId: string; project: string; command: string }` in types.ts; `interface ParsedTranscript { turns: Turn[]; events: CommandEvent[] }`, `parseTranscript(lines: string[]): ParsedTranscript`, `parseTranscriptFile(path: string): Promise<ParsedTranscript>` in parse.ts (`parseLines`/`parseFile` remain as turn-only wrappers); `scan()` accumulates `events: CommandEvent[]` (used by Tasks 5 and 10) and `ScanDeps.parseFn` becomes `(path: string) => Promise<ParsedTranscript>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/parse.test.ts`:

```ts
import { parseTranscript } from "./parse.js";

const commandTurn = JSON.stringify({
  type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "2026-06-01T00:05:00Z",
  message: { role: "user", content: "<command-name>/compact</command-name><command-message>compact</command-message><command-args></command-args>" },
});

describe("parseTranscript", () => {
  it("routes slash-command turns to events, not prompts", () => {
    const { turns, events } = parseTranscript([commandTurn, userString]);
    expect(turns.map(t => t.text)).toEqual(["fix the bug"]);
    expect(events).toEqual([{ ts: "2026-06-01T00:05:00Z", sessionId: "s1", project: "x", command: "/compact" }]);
  });
  it("keeps prompts that merely start with a non-command tag", () => {
    const jsx = JSON.stringify({ type: "user", sessionId: "s1", cwd: "/p/x", timestamp: "t",
      message: { role: "user", content: "<div>why is this broken?</div>" } });
    const { turns, events } = parseTranscript([jsx]);
    expect(turns.length).toBe(1);
    expect(events.length).toBe(0);
  });
});
```

In `src/core/filter.test.ts`, **delete** line 12 (`expect(isInjected("<command-name>/compact</command-name>")).toBe(true);`) — that text is now handled (and consumed) by parse, never reaching filter.

In `src/commands/scan.test.ts`, update the three `parseFn` stubs to the new shape:

```ts
      // line 17:
      { backend, collectFn: async () => ["f"], parseFn: async () => ({ turns, events: [] }), log: (m) => logs.push(m) },
      // line 29:
        { backend: null, collectFn: async () => ["f"], parseFn: async () => ({ turns: big, events: [] }), log: (m) => logs.push(m) },
      // lines 52-56:
        parseFn: async () => ({ events: [], turns: [
          { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s1" },
          { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s2" },
          { ts: "t", project: "x", role: "user", text: "push and create a pull request", sessionId: "s3" },
        ] }),
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/parse.test.ts src/commands/scan.test.ts`
Expected: FAIL — `parseTranscript` not exported; scan type errors.

- [ ] **Step 3: Implement**

`src/core/types.ts` — add after `Turn`:

```ts
/** A slash-command invocation extracted from a transcript (never clustered). */
export interface CommandEvent {
  ts: string;
  sessionId: string;
  project: string;
  command: string;   // e.g. "/compact"
}
```

`src/core/parse.ts` — extract events; keep old exports as wrappers:

```ts
import { readFile } from "node:fs/promises";
import type { Turn, CommandEvent } from "./types.js";

export interface ParsedTranscript { turns: Turn[]; events: CommandEvent[] }

const COMMAND_RE = /^\s*<command-name>([^<]+)<\/command-name>/;

// (parseOne unchanged)

export function parseTranscript(lines: string[]): ParsedTranscript {
  const turns: Turn[] = [];
  const events: CommandEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const t = parseOne(line);
    if (!t) continue;
    const m = COMMAND_RE.exec(t.text ?? "");
    if (m) {
      events.push({ ts: t.ts, sessionId: t.sessionId, project: t.project, command: m[1].trim() });
    } else {
      turns.push(t);
    }
  }
  return { turns, events };
}

export function parseLines(lines: string[]): Turn[] {
  return parseTranscript(lines).turns;
}

export async function parseTranscriptFile(path: string): Promise<ParsedTranscript> {
  const content = await readFile(path, "utf8");
  return parseTranscript(content.split(/\r?\n/));
}

export async function parseFile(path: string): Promise<Turn[]> {
  return (await parseTranscriptFile(path)).turns;
}
```

Also update the header comment (`// v1 parses only genuine user prompts…`) to: `// Parses genuine user prompts plus slash-command invocation events; assistant turns are consumed by core/tail.ts (Spec 2), not here.`

`src/core/filter.ts` — delete the first pattern line:

```ts
const INJECTED_PATTERNS: RegExp[] = [
  /<system-reminder>/i,
  /local-command-stdout/i,
  /^Base directory for/i,
  /^Caveat:/i,
  /^\[Request interrupted/i,
];
```

`src/commands/scan.ts` — new dep type and event accumulation:

```ts
import { parseTranscriptFile, type ParsedTranscript } from "../core/parse.js";
import type { Suggestion, Turn, Config, CommandEvent } from "../core/types.js";
// ScanDeps:
  parseFn?: (path: string) => Promise<ParsedTranscript>;
// in scan():
  const parseFn = deps.parseFn ?? parseTranscriptFile;
  const files = await collectFn(opts);
  log(`files: ${files.length} transcripts`);
  const turns: Turn[] = [];
  const events: CommandEvent[] = [];
  for (const f of files) {
    const parsed = await parseFn(f);
    turns.push(...parsed.turns);
    events.push(...parsed.events);
  }
```

(`events` is unused until Tasks 5/10 — that is fine for one task; do not add a lint suppression, just reference it in the log line: `log(\`prompts: ${prompts.length} after filtering injected text (+${events.length} command events)\`);`)

- [ ] **Step 4: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS (including the updated filter test).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): parse slash-command invocations as structured events (was: filtered out)"
```

---

### Task 4: `core/leverage.ts` + stable ids + `sourceSignatures` + leverage ordering in detect

**Files:**
- Create: `src/core/leverage.ts`
- Modify: `src/core/types.ts` (Suggestion.evidence + sourceSignatures)
- Modify: `src/core/detect.ts` (idFor, evidenceFor, ordering, candidateToCommand)
- Modify: `src/cli.ts:113` (scan print gains `~m/mo`)
- Test: `src/core/leverage.test.ts`, `src/core/detect.test.ts`

**Interfaces:**
- Consumes: `spanDays` from `temporal.js` (Task 2); `Candidate.occurrences` (Task 1).
- Produces in `leverage.ts`: `TYPING_CPS = 3.3`, `ROUND_TRIP_S = 15`, `CORRECTION_S = 60`; `type LeverageKind = "command" | "loop" | "hook" | "claude-md"`; `estMinutesSavedPerMonth(a: { count: number; chars: number; spanDays: number; kind: LeverageKind }): number`; `candidateLeverage(c: Candidate): number`.
- Produces in `detect.ts`: `idFor(sigs: string[]): string` (**exported** — Task 5's `classify.ts` imports it); `evidenceFor(matched: Candidate[], payloadType: string): Suggestion["evidence"]` (module-private helper); every produced `Suggestion` carries `sourceSignatures: string[]` (redacted member cluster signatures) and `evidence.estMinutesSavedPerMonth`; detect's window AND its returned order are leverage-descending.
- Produces in `types.ts`: `Suggestion.sourceSignatures?: string[]`; `Suggestion.evidence` becomes `{ count: number; sessions: number; estMinutesSavedPerMonth?: number; temporal?: TemporalFeatures }`.

- [ ] **Step 1: Write the failing tests**

Create `src/core/leverage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { estMinutesSavedPerMonth, candidateLeverage } from "./leverage.js";
import type { Candidate } from "./types.js";

describe("estMinutesSavedPerMonth", () => {
  it("prices a command by typing time plus round-trip, normalized to 30 days", () => {
    // 12 occurrences of a 66-char prompt over 30 days:
    // perOcc = 66/3.3 + 15 = 35s → total 420s = 7m → ×(30/30) = 7
    expect(estMinutesSavedPerMonth({ count: 12, chars: 66, spanDays: 30, kind: "command" })).toBe(7);
  });
  it("prices loops and hooks at the round-trip cost only", () => {
    // 60 × 15s = 15m over 30 days
    expect(estMinutesSavedPerMonth({ count: 60, chars: 8, spanDays: 30, kind: "loop" })).toBe(15);
  });
  it("prices claude-md rules at a wasted round-trip per correction", () => {
    // 7 × 60s = 7m over 30 days
    expect(estMinutesSavedPerMonth({ count: 7, chars: 20, spanDays: 30, kind: "claude-md" })).toBe(7);
  });
  it("clamps short observation spans to 7 days so fresh data isn't inflated", () => {
    const twoDay = estMinutesSavedPerMonth({ count: 10, chars: 33, spanDays: 2, kind: "command" });
    const sevenDay = estMinutesSavedPerMonth({ count: 10, chars: 33, spanDays: 7, kind: "command" });
    expect(twoDay).toBe(sevenDay);
  });
});

describe("candidateLeverage", () => {
  const base: Candidate = {
    kind: "unknown", signature: "push and open a pr and review it", examples: [], count: 10,
    sessions: 5, sessionIds: [], confidence: "high",
    occurrences: [{ ts: "2026-06-01T00:00:00Z", sessionId: "s" }, { ts: "2026-06-15T00:00:00Z", sessionId: "s" }],
    memberSignatures: ["push and open a pr and review it"],
  };
  it("ranks a long repeated workflow above a short ack with equal counts", () => {
    const ack: Candidate = { ...base, signature: "ok", memberSignatures: ["ok"] };
    expect(candidateLeverage(base)).toBeGreaterThan(candidateLeverage(ack));
  });
  it("uses the loop price for loop-kind candidates", () => {
    const loop: Candidate = { ...base, kind: "loop" };
    expect(candidateLeverage(loop)).toBeLessThan(candidateLeverage(base));
  });
});
```

Append to `src/core/detect.test.ts`:

```ts
  it("gives the same suggestion the same id regardless of what the llm names it", async () => {
    const llmNamed = (name: string) => ({
      name: "fake", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [{
        sourceSignatures: ["push and create a pr"],
        name, title: "T", rationale: "r", confidence: "high",
        payload: { type: "command", commandName: name, body: "x" },
      }] }),
    });
    const a = await detect([cand("push and create a pr", 5)], llmNamed("ship"));
    const b = await detect([cand("push and create a pr", 5)], llmNamed("push-pr"));
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].sourceSignatures).toEqual(["push and create a pr"]);
  });
  it("orders the detect window by leverage, not raw count", async () => {
    let seenPrompt = "";
    const llm = { name: "f", available: async () => true,
      complete: async (req: any) => { seenPrompt = req.prompt; return JSON.stringify({ suggestions: [] }); } };
    const ack = cand("ok", 10);
    const workflow = cand("review the spec then write the implementation plan and begin", 8);
    await detect([ack, workflow], llm, { limit: 1 });
    expect(seenPrompt).toContain("review the spec");
    expect(seenPrompt).not.toContain('"ok"');
  });
  it("computes estMinutesSavedPerMonth on degraded suggestions", async () => {
    const out = await detect([cand("merge main into this pr", 9)], null);
    expect(out[0].evidence.estMinutesSavedPerMonth).toBeGreaterThan(0);
    expect(out[0].sourceSignatures).toEqual(["merge main into this pr"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/leverage.test.ts src/core/detect.test.ts`
Expected: FAIL — `./leverage.js` missing; id/order assertions fail.

- [ ] **Step 3: Implement**

Create `src/core/leverage.ts`:

```ts
import type { Candidate } from "./types.js";
import { spanDays } from "./temporal.js";

/** ~40wpm typing speed. */
export const TYPING_CPS = 3.3;
/** Fixed context-switch cost of typing any nudge/prompt, seconds. */
export const ROUND_TRIP_S = 15;
/** A repeated correction costs a full wasted model round-trip, seconds. */
export const CORRECTION_S = 60;

export type LeverageKind = "command" | "loop" | "hook" | "claude-md";

/** Conservative, explainable estimate of minutes/month a suggestion gives back. */
export function estMinutesSavedPerMonth(a: { count: number; chars: number; spanDays: number; kind: LeverageKind }): number {
  const perOccurrenceSeconds =
    a.kind === "command" ? a.chars / TYPING_CPS + ROUND_TRIP_S :
    a.kind === "claude-md" ? CORRECTION_S :
    ROUND_TRIP_S; // loop, hook
  const minutesTotal = (a.count * perOccurrenceSeconds) / 60;
  const perMonth = minutesTotal * (30 / Math.max(a.spanDays, 7));
  return Math.round(perMonth * 10) / 10;
}

/** Pre-LLM leverage estimate for ordering the detect window. */
export function candidateLeverage(c: Candidate): number {
  const kind: LeverageKind = c.kind === "loop" ? "loop" : "command";
  return estMinutesSavedPerMonth({ count: c.count, chars: c.signature.length, spanDays: spanDays(c.occurrences), kind });
}
```

`src/core/types.ts` — Suggestion evidence + sourceSignatures:

```ts
export interface Suggestion {
  id: string;
  name: string;
  title: string;
  rationale: string;
  evidence: { count: number; sessions: number; estMinutesSavedPerMonth?: number; temporal?: TemporalFeatures };
  confidence: Confidence;
  /** Redacted member cluster signatures — the suggestion's stable identity + dismissal key. */
  sourceSignatures?: string[];
  examples?: string[];
  payload: SuggestionPayload;
}
```

`src/core/detect.ts` — rewrite identity/evidence/ordering:

```ts
import { createHash } from "node:crypto";
import type { Candidate, Suggestion, Confidence } from "./types.js";
import { sanitizeName, redact } from "./security.js";
import { estMinutesSavedPerMonth, type LeverageKind } from "./leverage.js";
import { spanDays } from "./temporal.js";
import { candidateLeverage } from "./leverage.js";
import type { LLMBackend } from "../llm/backend.js";

const ALLOWED_CONFIDENCE = new Set(["high", "inferred", "flagged"]);

/** Stable id: hash of the sorted member signatures, not of any LLM-chosen name. */
export function idFor(sigs: string[]): string {
  return createHash("sha1").update([...sigs].sort().join("\n")).digest("hex").slice(0, 10);
}

function evidenceFor(matched: Candidate[], payloadType: string): Suggestion["evidence"] {
  const count = matched.reduce((n, c) => n + c.count, 0);
  const sessions = new Set(matched.flatMap(c => c.sessionIds)).size;
  const occs = matched.flatMap(c => c.occurrences);
  const chars = matched.length ? Math.max(...matched.map(c => c.signature.length)) : 0;
  const kind: LeverageKind =
    payloadType === "loop" || payloadType === "hook" || payloadType === "claude-md" ? payloadType : "command";
  const primary = matched.length ? matched.reduce((a, b) => (b.count > a.count ? b : a)) : undefined;
  return {
    count, sessions,
    estMinutesSavedPerMonth: estMinutesSavedPerMonth({ count, chars, spanDays: spanDays(occs), kind }),
    temporal: primary?.temporal,
  };
}

const byLeverage = (a: Suggestion, b: Suggestion) =>
  (b.evidence.estMinutesSavedPerMonth ?? 0) - (a.evidence.estMinutesSavedPerMonth ?? 0);

export function candidateToCommand(c: Candidate): Suggestion {
  const words = c.signature.split(" ").slice(0, 3).join(" ");
  const commandName = sanitizeName(words);
  return {
    id: idFor([redact(c.signature)]),
    name: commandName,
    title: `Reusable command for "${c.signature}"`,
    rationale: `Repeated ${c.count}× across ${c.sessions} sessions.`,
    evidence: evidenceFor([c], "command"),
    confidence: c.confidence,
    sourceSignatures: [redact(c.signature)],
    examples: c.examples.map(redact).slice(0, 5),
    payload: { type: "command", commandName, body: c.examples[0] ?? c.signature },
  };
}

function degradeToCommands(cands: Candidate[]): Suggestion[] {
  return cands.filter(c => c.confidence === "high").map(candidateToCommand);
}
```

In `detect()` swap the ordering and evidence mapping:

```ts
  const limit = opts.limit ?? 12;
  const ranked = [...cands].sort((a, b) => candidateLeverage(b) - candidateLeverage(a));
  const top = ranked.slice(0, limit);
```

and in the LLM-result `.map(...)`:

```ts
        const sigs = s.sourceSignatures ?? (s.sourceSignature ? [s.sourceSignature] : []);
        const matched = sigs.map(sig => bySignature.get(redact(sig))).filter((c): c is Candidate => !!c);
        const matchedSigs = matched.map(c => redact(c.signature));
        const examples = matched.flatMap(c => c.examples).map(redact).slice(0, 5);
        return {
          id: idFor(matchedSigs.length ? matchedSigs : [s.name]),
          name: s.name,
          title: s.title,
          rationale: s.rationale,
          evidence: evidenceFor(matched, s.payload.type),
          confidence: ALLOWED_CONFIDENCE.has(s.confidence) ? s.confidence : "inferred",
          sourceSignatures: matchedSigs,
          examples,
          payload: s.payload,
        };
```

Both return paths get a final sort: LLM path ends with `.sort(byLeverage)` on the mapped array; degrade paths return `degradeToCommands(top).sort(byLeverage)`.

`src/cli.ts` scan print (line 113):

```ts
          log(
            `  ${confidenceChip(s.confidence)} ${c.bold(s.name)}  ${c.muted(s.title)}  ${c.dim(`(≈ ${s.evidence.estMinutesSavedPerMonth ?? 0}m/mo · ${s.evidence.count}×)`)}`,
          );
```

- [ ] **Step 4: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS (existing detect tests still green — evidence count/sessions semantics unchanged).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): leverage-based ranking + stable signature-set suggestion ids"
```

---

### Task 5: Deterministic loop/schedule/hook classification

**Files:**
- Create: `src/core/classify.ts`
- Modify: `src/core/types.ts` (`Candidate.cadence?`)
- Modify: `src/core/detect.ts` (prompt serialization, `candidateToLoop`, degrade path, loop enforcement)
- Modify: `src/commands/scan.ts` (markLoops before detect; hookFromEvents after)
- Test: `src/core/classify.test.ts`, `src/core/detect.test.ts`

**Interfaces:**
- Consumes: `Candidate.temporal` (Task 2), `CommandEvent[]` (Task 3), `idFor`/`evidenceFor` pattern (Task 4), `estMinutesSavedPerMonth`/`spanDays`.
- Produces in `classify.ts`: `LOOP_MIN_RUN = 3`, `LOOP_MIN_RUN_SESSIONS = 2`, `SCHEDULE_MIN_DAYS = 5`, `HOOK_MIN_COUNT = 10`, `HOOK_MIN_SESSIONS = 3`; `markLoops(candidates: Candidate[]): void` (sets `kind = "loop"` and, for near-daily habits, `cadence`); `deriveDailyCadence(c: Candidate): string`; `hookFromEvents(events: CommandEvent[]): Suggestion | null`.
- Produces in `detect.ts`: `candidateToLoop(c: Candidate): Suggestion` (exported); degrade path emits loops + commands; LLM path appends `candidateToLoop` for any loop-kind candidate the LLM's response didn't reference.

- [ ] **Step 1: Write the failing tests**

Create `src/core/classify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { markLoops, deriveDailyCadence, hookFromEvents } from "./classify.js";
import type { Candidate, CommandEvent } from "./types.js";

const base = (over: Partial<Candidate>): Candidate => ({
  kind: "unknown", signature: "continue", examples: ["continue"], count: 10, sessions: 4,
  sessionIds: ["s1", "s2", "s3", "s4"], confidence: "high",
  occurrences: [{ ts: "2026-06-01T09:00:00Z", sessionId: "s1" }],
  memberSignatures: ["continue"],
  temporal: { maxRunLength: 1, runSessions: 0, medianGapMinutes: 60, distinctDays: 1, spanDays: 0 },
  ...over,
});

describe("markLoops", () => {
  it("classifies a run-heavy cluster as a loop", () => {
    const c = base({ temporal: { maxRunLength: 4, runSessions: 3, medianGapMinutes: 3, distinctDays: 5, spanDays: 12 } });
    markLoops([c]);
    expect(c.kind).toBe("loop");
    expect(c.cadence).toBeUndefined();
  });
  it("derives a daily cadence for near-daily habits without runs", () => {
    const occurrences = Array.from({ length: 6 }, (_, i) => ({ ts: `2026-06-0${i + 1}T09:15:00Z`, sessionId: `s${i}` }));
    const c = base({ occurrences, temporal: { maxRunLength: 1, runSessions: 0, medianGapMinutes: 1440, distinctDays: 6, spanDays: 5 } });
    markLoops([c]);
    expect(c.kind).toBe("loop");
    expect(c.cadence).toMatch(/^0 \d{1,2} \* \* \*$/);
  });
  it("leaves ordinary clusters untouched", () => {
    const c = base({ temporal: { maxRunLength: 2, runSessions: 1, medianGapMinutes: 60, distinctDays: 2, spanDays: 3 } });
    markLoops([c]);
    expect(c.kind).toBe("unknown");
  });
});

describe("deriveDailyCadence", () => {
  it("uses the median local hour", () => {
    const c = base({ occurrences: [
      { ts: "2026-06-01T09:00:00", sessionId: "a" },
      { ts: "2026-06-02T10:00:00", sessionId: "b" },
      { ts: "2026-06-03T11:00:00", sessionId: "c" },
    ] });
    expect(deriveDailyCadence(c)).toBe("0 10 * * *");
  });
});

describe("hookFromEvents", () => {
  const ev = (i: number, sessionId: string): CommandEvent =>
    ({ ts: `2026-06-${String((i % 27) + 1).padStart(2, "0")}T10:00:00Z`, sessionId, project: "p", command: "/compact" });
  it("suggests a PreCompact hook from frequent /compact use, no LLM involved", () => {
    const events = Array.from({ length: 12 }, (_, i) => ev(i, `s${i % 4}`));
    const s = hookFromEvents(events)!;
    expect(s.payload).toEqual({ type: "hook", event: "PreCompact", subcommand: "checkpoint",
      description: "Write a session checkpoint before compaction." });
    expect(s.evidence.count).toBe(12);
    expect(s.evidence.sessions).toBe(4);
    expect(s.confidence).toBe("high");
  });
  it("returns null below thresholds", () => {
    expect(hookFromEvents(Array.from({ length: 9 }, (_, i) => ev(i, `s${i}`)))).toBeNull();
    expect(hookFromEvents(Array.from({ length: 12 }, (_, i) => ev(i, "s1")))).toBeNull();
  });
});
```

Append to `src/core/detect.test.ts`:

```ts
  it("emits loop suggestions in degraded (no-llm) mode for loop-kind candidates", async () => {
    const loopCand: Candidate = { ...cand("continue", 10), kind: "loop",
      temporal: { maxRunLength: 4, runSessions: 3, medianGapMinutes: 3, distinctDays: 5, spanDays: 10 } };
    const out = await detect([loopCand], null);
    expect(out.some(s => s.payload.type === "loop")).toBe(true);
  });
  it("appends a deterministic loop when the llm response ignores a loop-kind candidate", async () => {
    const loopCand: Candidate = { ...cand("continue", 10), kind: "loop" };
    const llm = { name: "f", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [] }) };
    const out = await detect([loopCand], llm);
    expect(out.length).toBe(1);
    expect(out[0].payload.type).toBe("loop");
  });
  it("serializes kind and temporal evidence into the detect prompt", async () => {
    let seenPrompt = "";
    const llm = { name: "f", available: async () => true,
      complete: async (req: any) => { seenPrompt = req.prompt; return JSON.stringify({ suggestions: [] }); } };
    const loopCand: Candidate = { ...cand("continue", 10), kind: "loop",
      temporal: { maxRunLength: 4, runSessions: 3, medianGapMinutes: 3, distinctDays: 5, spanDays: 10 } };
    await detect([loopCand], llm);
    expect(seenPrompt).toContain('"kind": "loop"');
    expect(seenPrompt).toContain('"maxRunLength": 4');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/classify.test.ts src/core/detect.test.ts`
Expected: FAIL — `./classify.js` missing; loop assertions fail.

- [ ] **Step 3: Implement**

`src/core/types.ts` — on `Candidate`, after `temporal?`: `cadence?: string;  // derived daily cron (classify.ts), never LLM-authored`

Create `src/core/classify.ts`:

```ts
import type { Candidate, CommandEvent, Suggestion } from "./types.js";
import { idFor } from "./detect.js";
import { estMinutesSavedPerMonth } from "./leverage.js";
import { spanDays } from "./temporal.js";

export const LOOP_MIN_RUN = 3;
export const LOOP_MIN_RUN_SESSIONS = 2;
export const SCHEDULE_MIN_DAYS = 5;
export const HOOK_MIN_COUNT = 10;
export const HOOK_MIN_SESSIONS = 3;

/** Median local hour of the occurrences, as a daily cron line (valid by construction). */
export function deriveDailyCadence(c: Candidate): string {
  const hours = c.occurrences.map(o => new Date(o.ts).getHours()).filter(Number.isFinite).sort((a, b) => a - b);
  const h = hours.length ? hours[Math.floor(hours.length / 2)] : 9;
  return `0 ${h} * * *`;
}

/** Deterministic pre-classification: the LLM refines wording but cannot miss these. */
export function markLoops(candidates: Candidate[]): void {
  for (const c of candidates) {
    const t = c.temporal;
    if (!t || c.kind !== "unknown") continue;
    if (t.maxRunLength >= LOOP_MIN_RUN && t.runSessions >= LOOP_MIN_RUN_SESSIONS) {
      c.kind = "loop";
      continue;
    }
    if (t.distinctDays >= SCHEDULE_MIN_DAYS && t.spanDays > 0 && t.spanDays / t.distinctDays <= 2) {
      c.kind = "loop";
      c.cadence = deriveDailyCadence(c);
    }
  }
}

/** Frequent /compact use → PreCompact checkpoint hook, no LLM required. */
export function hookFromEvents(events: CommandEvent[]): Suggestion | null {
  const compacts = events.filter(e => e.command === "/compact");
  const sessions = new Set(compacts.map(e => e.sessionId));
  if (compacts.length < HOOK_MIN_COUNT || sessions.size < HOOK_MIN_SESSIONS) return null;
  return {
    id: idFor(["/compact"]),
    name: "pre-compact-checkpoint",
    title: "Checkpoint your session before every /compact",
    rationale: `You ran /compact ${compacts.length}× across ${sessions.size} sessions; a PreCompact hook writes a checkpoint automatically first.`,
    evidence: {
      count: compacts.length,
      sessions: sessions.size,
      estMinutesSavedPerMonth: estMinutesSavedPerMonth({ count: compacts.length, chars: 8, spanDays: spanDays(compacts), kind: "hook" }),
    },
    confidence: "high",
    sourceSignatures: ["/compact"],
    examples: [],
    payload: { type: "hook", event: "PreCompact", subcommand: "checkpoint", description: "Write a session checkpoint before compaction." },
  };
}
```

`src/core/detect.ts`:

Add `candidateToLoop` (near `candidateToCommand`):

```ts
export function candidateToLoop(c: Candidate): Suggestion {
  const t = c.temporal;
  const words = c.signature.split(" ").slice(0, 3).join(" ");
  return {
    id: idFor([redact(c.signature)]),
    name: sanitizeName(words),
    title: `Recurring nudge: "${c.signature}"`,
    rationale: t
      ? `Typed in runs of up to ${t.maxRunLength} within a session, across ${c.sessions} sessions (median gap ${t.medianGapMinutes}m).`
      : `Repeated ${c.count}× across ${c.sessions} sessions.`,
    evidence: evidenceFor([c], "loop"),
    confidence: c.confidence,
    sourceSignatures: [redact(c.signature)],
    examples: c.examples.map(redact).slice(0, 5),
    payload: { type: "loop", instruction: c.examples[0] ?? c.signature, cadence: c.cadence },
  };
}
```

Replace `degradeToCommands` with a loop-aware degrade:

```ts
function degrade(cands: Candidate[]): Suggestion[] {
  const loops = cands.filter(c => c.kind === "loop").map(candidateToLoop);
  const commands = cands.filter(c => c.kind !== "loop" && c.confidence === "high").map(candidateToCommand);
  return [...loops, ...commands];
}
```

(update both `return degradeToCommands(top)` call sites to `return degrade(top).sort(byLeverage)`).

`buildDetectPrompt` — system prompt (full replacement string) and serialization:

```ts
  const system =
    "You convert clusters of a developer's repeated Claude Code prompts into reusable artifacts. " +
    "For each cluster decide a type: 'command' (a repeated instruction → slash command), " +
    "'loop' (a recurring cadence task), or 'hook' (an automation tied to a Claude Code lifecycle event; " +
    "the only supported hook event is PreCompact backed by the gradient subcommand 'checkpoint'). " +
    "Clusters may carry pre-computed evidence: 'kind' is a deterministic pre-classification — keep kind:'loop' clusters " +
    "as loops and reuse their provided 'cadence' verbatim; 'temporal' is measured " +
    "{maxRunLength,runSessions,medianGapMinutes,distinctDays,spanDays} — cite it in rationales. " +
    "Merge clusters that mean the same thing (e.g. 'lgtm' and 'looks good') into ONE suggestion. " +
    "Echo back EVERY merged cluster's exact 'signature' in a 'sourceSignatures' string array so evidence can be summed. " +
    "Respond ONLY with JSON: {\"suggestions\":[{sourceSignatures,name,title,rationale,confidence,payload}]} where payload is one of " +
    "{type:'command',commandName,body} | {type:'loop',instruction,cadence?} | {type:'hook',event:'PreCompact',subcommand:'checkpoint',description}. " +
    "confidence must be exactly one of \"high\", \"inferred\", or \"flagged\".";
  const prompt = JSON.stringify(
    cands.map(c => ({
      signature: redact(c.signature),
      count: c.count,
      sessions: c.sessions,
      examples: c.examples.map(redact),
      confidence: c.confidence,
      ...(c.kind !== "unknown" ? { kind: c.kind } : {}),
      ...(c.temporal ? { temporal: c.temporal } : {}),
      ...(c.cadence ? { cadence: c.cadence } : {}),
    })),
    null, 2,
  );
```

Loop enforcement in the LLM path (after mapping `parsed.suggestions`, before the final sort):

```ts
    const out = (parsed.suggestions ?? []) /* …existing filter/map… */;
    const consumed = new Set(out.flatMap(s => s.sourceSignatures ?? []));
    for (const c of top) {
      if (c.kind === "loop" && !consumed.has(redact(c.signature))) out.push(candidateToLoop(c));
    }
    return out.sort(byLeverage);
```

`src/commands/scan.ts` — wire classification (after `annotateTemporal`) and the deterministic hook (after validation):

```ts
import { markLoops, hookFromEvents } from "../core/classify.js";
// after annotateTemporal(kept, candidates):
  markLoops(candidates);
// after the validate loop that fills `valid`:
  const hook = hookFromEvents(events);
  if (hook && !valid.some(s => s.id === hook.id)) valid.push(hook);
  valid.sort((a, b) => (b.evidence.estMinutesSavedPerMonth ?? 0) - (a.evidence.estMinutesSavedPerMonth ?? 0));
```

- [ ] **Step 4: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): deterministic loop/schedule/hook detection from temporal + command-event evidence"
```

---

### Task 6: `claude-md` payload type end-to-end (types → emit → apply → remove)

**Files:**
- Modify: `src/core/types.ts` (payload union, ArtifactType)
- Modify: `src/core/validate.ts:3-28`
- Create: `src/core/claudeMd.ts`
- Modify: `src/core/emit/index.ts`
- Modify: `src/core/apply.ts`
- Modify: `src/commands/remove.ts`
- Modify: `src/core/ui.ts:68-77` (kindLabel)
- Test: `src/core/claudeMd.test.ts`, `src/core/emit/emit.test.ts`, `src/core/apply.test.ts`, `src/core/validate.test.ts`

**Interfaces:**
- Consumes: manifest/apply plumbing as-is.
- Produces: payload variant `{ type: "claude-md"; rule: string }`; `ArtifactType = "command" | "loop" | "hook" | "claude-md"`; in `claudeMd.ts`: `RULES_START = "<!-- gradient:rules:start -->"`, `RULES_END = "<!-- gradient:rules:end -->"`, `addRule(existing: string | null, rule: string, id: string): string`, `removeRule(existing: string, id: string): string`, `claudeMdPath(projectDir: string): string`; `EmitResult` gains `{ kind: "claude-md"; rule: string }`. Task 7 relies on the payload type; Task 9/10 display code relies on `kindLabel` accepting it.

- [ ] **Step 1: Write the failing tests**

Create `src/core/claudeMd.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { addRule, removeRule, RULES_START, RULES_END } from "./claudeMd.js";

describe("addRule", () => {
  it("creates the managed block in an empty/missing file", () => {
    const out = addRule(null, "Use pnpm, never npm.", "abc123");
    expect(out).toBe(`${RULES_START}\n- Use pnpm, never npm. <!-- gradient:abc123 -->\n${RULES_END}\n`);
  });
  it("appends inside an existing block without touching outside content", () => {
    const existing = `# My project\n\n${RULES_START}\n- Old rule. <!-- gradient:old111 -->\n${RULES_END}\n\n## Notes\n`;
    const out = addRule(existing, "Run tests before committing.", "new222");
    expect(out).toContain("- Old rule. <!-- gradient:old111 -->\n- Run tests before committing. <!-- gradient:new222 -->");
    expect(out.startsWith("# My project")).toBe(true);
    expect(out).toContain("## Notes");
  });
  it("is idempotent for an id that is already present", () => {
    const once = addRule(null, "Use pnpm.", "abc123");
    expect(addRule(once, "Use pnpm.", "abc123")).toBe(once);
  });
  it("refuses a malformed block (start without end)", () => {
    expect(() => addRule(`${RULES_START}\n- dangling`, "x", "id1")).toThrow(/malformed/i);
  });
});

describe("removeRule", () => {
  it("removes exactly the id-tagged line", () => {
    const file = `intro\n${RULES_START}\n- A. <!-- gradient:aaa -->\n- B. <!-- gradient:bbb -->\n${RULES_END}\n`;
    const out = removeRule(file, "aaa");
    expect(out).not.toContain("gradient:aaa");
    expect(out).toContain("- B. <!-- gradient:bbb -->");
    expect(out).toContain("intro");
  });
  it("returns the input unchanged when the id is absent", () => {
    const file = `${RULES_START}\n- B. <!-- gradient:bbb -->\n${RULES_END}\n`;
    expect(removeRule(file, "zzz")).toBe(file);
  });
});
```

Append to `src/core/emit/emit.test.ts`:

```ts
  it("emits a claude-md rule payload", () => {
    const s: Suggestion = { ...base, name: "pnpm-rule", payload: { type: "claude-md", rule: "Use pnpm, never npm." } };
    const r = emit(s);
    if (r.kind !== "claude-md") throw new Error("wrong kind");
    expect(r.rule).toBe("Use pnpm, never npm.");
  });
```

Append to `src/core/apply.test.ts`:

```ts
  it("appends a claude-md rule to the managed block and records it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const s: Suggestion = { ...base, id: "rid123", name: "pnpm-rule", payload: { type: "claude-md", rule: "Use pnpm, never npm." } };
    const r = await applySuggestion(s, dir);
    expect(r.written).toBe(join(dir, "CLAUDE.md"));
    const content = await readFile(r.written!, "utf8");
    expect(content).toContain("- Use pnpm, never npm. <!-- gradient:rid123 -->");
    expect((await loadManifest(dir))[0]).toMatchObject({ name: "pnpm-rule", type: "claude-md" });
  });
```

Append to `src/core/validate.test.ts` (inside `describe("validateSuggestion")`):

```ts
  it("accepts a claude-md payload with a rule", () => {
    expect(() => validateSuggestion({ ...good, payload: { type: "claude-md", rule: "Use pnpm." } })).not.toThrow();
  });
  it("rejects a claude-md payload without a rule", () => {
    expect(() => validateSuggestion({ ...good, payload: { type: "claude-md" } })).toThrow();
  });
```

Append to `src/commands/manage.test.ts` (the existing remove/list test file) — a self-contained describe block with its own imports, so it does not depend on that file's helpers:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remove } from "./remove.js";
import { applySuggestion } from "../core/apply.js";
import type { Suggestion } from "../core/types.js";

describe("remove claude-md", () => {
  it("removes a claude-md rule line instead of unlinking a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    const s: Suggestion = {
      id: "rid123", name: "pnpm-rule", title: "t", rationale: "r",
      evidence: { count: 3, sessions: 2 }, confidence: "high",
      payload: { type: "claude-md", rule: "Use pnpm, never npm." },
    };
    await applySuggestion(s, dir);
    expect(await remove(dir, "pnpm-rule")).toBe(true);
    const content = await readFile(join(dir, "CLAUDE.md"), "utf8");
    expect(content).not.toContain("gradient:rid123");
  });
});
```

(if those imports already exist at the top of the file, merge rather than duplicate them.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/claudeMd.test.ts src/core/emit/emit.test.ts src/core/apply.test.ts src/core/validate.test.ts src/commands/manage.test.ts`
Expected: FAIL — module missing, union type errors.

- [ ] **Step 3: Implement**

`src/core/types.ts`:

```ts
export type ArtifactType = "command" | "loop" | "hook" | "claude-md";

export type SuggestionPayload =
  | { type: "command"; commandName: string; body: string }
  | { type: "loop"; instruction: string; cadence?: string }
  | { type: "hook"; event: string; subcommand: string; description: string }
  | { type: "claude-md"; rule: string };
```

`src/core/validate.ts`:

```ts
const TYPES = new Set(["command", "loop", "hook", "claude-md"]);
// …and at the end of validateSuggestion:
  if (payload.type === "claude-md" && typeof payload.rule !== "string") {
    throw new Error("claude-md payload needs rule");
  }
```

Create `src/core/claudeMd.ts`:

```ts
import { join } from "node:path";

export const RULES_START = "<!-- gradient:rules:start -->";
export const RULES_END = "<!-- gradient:rules:end -->";

export function claudeMdPath(projectDir: string): string {
  return join(projectDir, "CLAUDE.md");
}

function ruleLine(rule: string, id: string): string {
  return `- ${rule.replace(/[\r\n]+/g, " ").trim()} <!-- gradient:${id} -->`;
}

/**
 * Insert a rule inside the managed block. gradient never touches content
 * outside the markers; a half-formed block is an error, never a guess.
 */
export function addRule(existing: string | null, rule: string, id: string): string {
  const line = ruleLine(rule, id);
  if (existing === null || existing.trim() === "") {
    return `${RULES_START}\n${line}\n${RULES_END}\n`;
  }
  if (existing.includes(`gradient:${id}`)) return existing;
  const start = existing.indexOf(RULES_START);
  const end = existing.indexOf(RULES_END);
  if (start === -1 && end === -1) {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${sep}${RULES_START}\n${line}\n${RULES_END}\n`;
  }
  if (start === -1 || end === -1 || end < start) {
    throw new Error("CLAUDE.md gradient block is malformed (unmatched markers) — fix it manually, then re-apply");
  }
  return `${existing.slice(0, end)}${line}\n${existing.slice(end)}`;
}

/** Delete exactly the id-tagged rule line; unknown ids are a no-op. */
export function removeRule(existing: string, id: string): string {
  const lines = existing.split("\n");
  const kept = lines.filter(l => !l.includes(`<!-- gradient:${id} -->`));
  return kept.length === lines.length ? existing : kept.join("\n");
}
```

`src/core/emit/index.ts`:

```ts
export type EmitResult =
  | { kind: "command"; path: string; content: string }
  | { kind: "loop"; command: string }
  | { kind: "hook"; settingsPatch: string }
  | { kind: "claude-md"; rule: string };

export function emit(s: Suggestion): EmitResult {
  switch (s.payload.type) {
    case "command": return { kind: "command", ...emitCommand(s) };
    case "loop": return { kind: "loop", ...emitLoop(s) };
    case "hook": return { kind: "hook", ...emitHook(s) };
    case "claude-md": return { kind: "claude-md", rule: s.payload.rule };
  }
}
```

`src/core/apply.ts` — new branch (imports: `readFile` from fs/promises, `addRule, claudeMdPath` from `./claudeMd.js`):

```ts
  } else if (result.kind === "claude-md") {
    const abs = claudeMdPath(projectDir);
    assertInside(projectDir, abs);
    let existing: string | null = null;
    try {
      existing = await readFile(abs, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // unreadable ≠ missing: never clobber
    }
    await writeFile(abs, addRule(existing, result.rule, s.id));
    written = abs;
  } else {
    printed = result.settingsPatch;
  }
```

`src/commands/remove.ts` — claude-md entries edit the block instead of unlinking:

```ts
import { readFile, writeFile, unlink } from "node:fs/promises";
import { removeRule, claudeMdPath } from "../core/claudeMd.js";
// inside remove(), before the unlink branch:
  if (entry.type === "claude-md") {
    const abs = claudeMdPath(projectDir);
    assertInside(projectDir, abs);
    try {
      await writeFile(abs, removeRule(await readFile(abs, "utf8"), entry.suggestionId));
    } catch { /* file already gone → nothing to edit */ }
    return true;
  }
```

`src/core/ui.ts` — `kindLabel` gains:

```ts
    case "claude-md":
      return c.orchid(type);
```

- [ ] **Step 4: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: claude-md rule artifact type with managed-block apply/remove"
```

---

### Task 7: Corrections mining → claude-md synthesis

**Files:**
- Create: `src/core/corrections.ts`
- Modify: `src/core/types.ts` (Candidate.kind union)
- Modify: `src/core/detect.ts` (prompt schema + degrade exclusion)
- Modify: `src/core/leverage.ts` (`candidateLeverage` correction branch)
- Modify: `src/commands/scan.ts` (markCorrections after markLoops)
- Test: `src/core/corrections.test.ts`, `src/core/detect.test.ts`

**Interfaces:**
- Consumes: normalized `Candidate.signature`; detect prompt from Task 5.
- Produces: `Candidate.kind: ArtifactType | "correction" | "unknown"`; `isCorrectionShaped(normalized: string): boolean` and `markCorrections(candidates: Candidate[]): void` in corrections.ts. The detect system prompt gains the `claude-md` payload alternative and the correction instruction.

- [ ] **Step 1: Write the failing tests**

Create `src/core/corrections.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isCorrectionShaped, markCorrections } from "./corrections.js";
import type { Candidate } from "./types.js";

describe("isCorrectionShaped", () => {
  it.each([
    "no, use pnpm not npm",
    "don't add comments",
    "stop adding comments to everything",
    "actually use the existing helper",
    "i told you to run the tests first",
    "you didn't run the linter",
    "wrong file, the config is in packages/core",
    "never push directly to main",
  ])("flags %j", (s) => expect(isCorrectionShaped(s)).toBe(true));
  it.each([
    "push and create a pull request",
    "continue",
    "write the implementation plan",
    "notes on the design",
  ])("keeps %j", (s) => expect(isCorrectionShaped(s)).toBe(false));
});

describe("markCorrections", () => {
  const c = (signature: string, kind: Candidate["kind"] = "unknown"): Candidate => ({
    kind, signature, examples: [signature], count: 4, sessions: 3, sessionIds: ["a", "b", "c"],
    occurrences: [{ ts: "2026-06-01T00:00:00Z", sessionId: "a" }], memberSignatures: [signature], confidence: "high",
  });
  it("marks correction-shaped clusters and leaves others", () => {
    const cands = [c("don't add comments"), c("push and open a pr")];
    markCorrections(cands);
    expect(cands[0].kind).toBe("correction");
    expect(cands[1].kind).toBe("unknown");
  });
  it("never overrides an existing loop classification", () => {
    const loop = c("no, keep going", "loop");
    markCorrections([loop]);
    expect(loop.kind).toBe("loop");
  });
});
```

Append to `src/core/detect.test.ts`:

```ts
  it("passes correction kind to the llm and accepts a claude-md suggestion back", async () => {
    let seenPrompt = "";
    const llm = {
      name: "f", available: async () => true,
      complete: async (req: any) => {
        seenPrompt = req.prompt;
        return JSON.stringify({ suggestions: [{
          sourceSignatures: ["don't add comments"],
          name: "no-comments", title: "Never add code comments", rationale: "r", confidence: "high",
          payload: { type: "claude-md", rule: "Do not add code comments unless asked." },
        }] });
      },
    };
    const correction: Candidate = { ...cand("don't add comments", 5), kind: "correction" };
    const out = await detect([correction], llm);
    expect(seenPrompt).toContain('"kind": "correction"');
    expect(out[0].payload.type).toBe("claude-md");
    expect(out[0].evidence.count).toBe(5);
  });
  it("does not degrade corrections into bogus commands without an llm", async () => {
    const correction: Candidate = { ...cand("don't add comments", 5), kind: "correction" };
    const out = await detect([correction], null);
    expect(out.length).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/corrections.test.ts src/core/detect.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/core/types.ts` — Candidate kind union: `kind: ArtifactType | "correction" | "unknown";`

Create `src/core/corrections.ts`:

```ts
import type { Candidate } from "./types.js";

/**
 * Correction-shaped prompt lexicon, applied to normalized signatures.
 * Precision over recall: a missed correction still surfaces as a command
 * cluster; a false positive burns a detect-window slot. Measured against the
 * dogfood corpus (spec §10 open question).
 */
const CORRECTION_PATTERNS: RegExp[] = [
  /^(no|nope|wrong)\b[ ,]/,
  /^(don'?t|do not|stop|never)\b/,
  /^actually\b/,
  /^i (said|told you|asked)\b/,
  /^you (didn'?t|forgot|missed|ignored)\b/,
  /^that'?s (not|wrong)\b/,
  /\buse \S+ not \S+/,
];

export function isCorrectionShaped(normalized: string): boolean {
  return CORRECTION_PATTERNS.some(re => re.test(normalized));
}

/** kind:"correction" routes the cluster to claude-md synthesis in detect. */
export function markCorrections(candidates: Candidate[]): void {
  for (const c of candidates) {
    if (c.kind === "unknown" && isCorrectionShaped(c.signature)) c.kind = "correction";
  }
}
```

Note: `"wrong file, the config is in packages/core"` must match — `^(no|nope|wrong)\b[ ,]` covers `wrong ` followed by a space or comma. Verify each `it.each` fixture against the exact regexes; adjust the lexicon (not the fixtures) if one misses.

`src/core/detect.ts` — final system prompt (full replacement; supersedes Task 5's version):

```ts
  const system =
    "You convert clusters of a developer's repeated Claude Code prompts into reusable artifacts. " +
    "For each cluster decide a type: 'command' (a repeated instruction → slash command), " +
    "'loop' (a recurring cadence task), 'hook' (an automation tied to a Claude Code lifecycle event; " +
    "the only supported hook event is PreCompact backed by the gradient subcommand 'checkpoint'), " +
    "or 'claude-md' (a durable rule for the project's CLAUDE.md, synthesized from repeated user corrections). " +
    "Clusters may carry pre-computed evidence: 'kind' is a deterministic pre-classification — keep kind:'loop' clusters " +
    "as loops and reuse their provided 'cadence' verbatim; treat kind:'correction' clusters as claude-md rules, " +
    "distilling what the user keeps correcting into one imperative rule sentence; 'temporal' is measured " +
    "{maxRunLength,runSessions,medianGapMinutes,distinctDays,spanDays} — cite it in rationales. " +
    "Merge clusters that mean the same thing (e.g. 'lgtm' and 'looks good') into ONE suggestion. " +
    "Echo back EVERY merged cluster's exact 'signature' in a 'sourceSignatures' string array so evidence can be summed. " +
    "Respond ONLY with JSON: {\"suggestions\":[{sourceSignatures,name,title,rationale,confidence,payload}]} where payload is one of " +
    "{type:'command',commandName,body} | {type:'loop',instruction,cadence?} | {type:'hook',event:'PreCompact',subcommand:'checkpoint',description} | " +
    "{type:'claude-md',rule}. " +
    "confidence must be exactly one of \"high\", \"inferred\", or \"flagged\".";
```

degrade path — corrections are LLM-only:

```ts
function degrade(cands: Candidate[]): Suggestion[] {
  const loops = cands.filter(c => c.kind === "loop").map(candidateToLoop);
  const commands = cands
    .filter(c => c.kind !== "loop" && c.kind !== "correction" && c.confidence === "high")
    .map(candidateToCommand);
  return [...loops, ...commands];
}
```

`src/core/leverage.ts` — corrections price as claude-md in window ordering:

```ts
export function candidateLeverage(c: Candidate): number {
  const kind: LeverageKind = c.kind === "loop" ? "loop" : c.kind === "correction" ? "claude-md" : "command";
  return estMinutesSavedPerMonth({ count: c.count, chars: c.signature.length, spanDays: spanDays(c.occurrences), kind });
}
```

`src/commands/scan.ts` — after `markLoops(candidates);`:

```ts
import { markCorrections } from "../core/corrections.js";
  markCorrections(candidates);
```

- [ ] **Step 4: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(core): mine repeated corrections into claude-md rule suggestions"
```

---

### Task 8: Post-merge pass — near-duplicate suggestions merge in code

**Files:**
- Modify: `src/core/detect.ts`
- Test: `src/core/detect.test.ts`

**Interfaces:**
- Consumes: `normalize`, `similarity` from `cluster.js`; `evidenceFor`, `idFor`, `byLeverage` (Task 4).
- Produces: `mergeNearDuplicates(suggestions: Suggestion[], bySignature: Map<string, Candidate>): Suggestion[]` (exported for tests); `detect()`'s LLM path returns `mergeNearDuplicates(out, bySignature).sort(byLeverage)`.

- [ ] **Step 1: Write the failing test — the lgtm dogfood fixture**

Append to `src/core/detect.test.ts`:

```ts
  it("merges near-duplicate suggestions the llm failed to consolidate (lgtm dogfood case)", async () => {
    const a: Candidate = { ...cand("lgtm", 3), sessionIds: ["s1", "s2"], sessions: 2 };
    const b: Candidate = { ...cand("looks good", 3), sessionIds: ["s2", "s3"], sessions: 2 };
    const llm = {
      name: "fake", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [
        { sourceSignatures: ["lgtm"], name: "lgtm-approve", title: "Approve via lgtm", rationale: "r", confidence: "flagged",
          payload: { type: "command", commandName: "lgtm", body: "Treat as sign-off: approve the open PR once checks pass." } },
        { sourceSignatures: ["looks good"], name: "looks-good-approve", title: "Approve via looks good", rationale: "r", confidence: "flagged",
          payload: { type: "command", commandName: "looks-good", body: "Treat as sign-off: approve the open PR once checks pass, same as lgtm." } },
      ] }),
    };
    const out = await detect([a, b], llm);
    expect(out.length).toBe(1);
    expect(out[0].evidence.count).toBe(6);       // 3 + 3
    expect(out[0].evidence.sessions).toBe(3);    // union {s1,s2,s3}
    expect([...out[0].sourceSignatures!].sort()).toEqual(["lgtm", "looks good"].sort());
  });
  it("does not merge suggestions of different payload types", async () => {
    const llm = {
      name: "fake", available: async () => true,
      complete: async () => JSON.stringify({ suggestions: [
        { sourceSignatures: ["continue"], name: "keep-going", title: "t", rationale: "r", confidence: "high",
          payload: { type: "loop", instruction: "continue" } },
        { sourceSignatures: ["continue please"], name: "keep-going-cmd", title: "t", rationale: "r", confidence: "high",
          payload: { type: "command", commandName: "keep-going", body: "continue" } },
      ] }),
    };
    const out = await detect([cand("continue", 5), cand("continue please", 4)], llm);
    expect(out.length).toBe(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/detect.test.ts`
Expected: FAIL — 2 suggestions returned in the first test.

- [ ] **Step 3: Implement**

`src/core/detect.ts` (imports gain `normalize, similarity` from `./cluster.js`):

```ts
const MERGE_SIM_THRESHOLD = 0.6;

function mergeText(s: Suggestion): string {
  const p = s.payload;
  const body =
    p.type === "command" ? p.body :
    p.type === "loop" ? p.instruction :
    p.type === "hook" ? p.description :
    p.rule;
  return normalize(`${s.name} ${body}`);
}

/**
 * The prompt asks the model to merge synonymous clusters; this pass is the
 * guarantee when it doesn't (observed in dogfooding: lgtm vs looks-good).
 * Only merges same-type suggestions; when the union of source signatures
 * can't be resolved back to candidates, the higher-leverage suggestion is
 * kept unchanged and the duplicate is dropped.
 */
export function mergeNearDuplicates(suggestions: Suggestion[], bySignature: Map<string, Candidate>): Suggestion[] {
  const hosts: Suggestion[] = [];
  const ordered = [...suggestions].sort(byLeverage);
  for (const s of ordered) {
    const host = hosts.find(h =>
      h.payload.type === s.payload.type && similarity(mergeText(h), mergeText(s)) >= MERGE_SIM_THRESHOLD);
    if (!host) { hosts.push(s); continue; }
    const union = [...new Set([...(host.sourceSignatures ?? []), ...(s.sourceSignatures ?? [])])];
    if (union.length && union.every(sig => bySignature.has(sig))) {
      const matched = union.map(sig => bySignature.get(sig)!) ;
      host.sourceSignatures = union;
      host.evidence = evidenceFor(matched, host.payload.type);
      host.id = idFor(union);
      host.examples = [...new Set([...(host.examples ?? []), ...(s.examples ?? [])])].slice(0, 5);
    }
  }
  return hosts;
}
```

LLM path return becomes:

```ts
    return mergeNearDuplicates(out, bySignature).sort(byLeverage);
```

(`out` here is the mapped array including the Task 5 loop enforcement appends; the degrade path stays unmerged — degraded suggestions are one-per-signature by construction.)

- [ ] **Step 4: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix(core): deterministic post-merge of near-duplicate suggestions (llm merge is a hint, not a guarantee)"
```

---

### Task 9: Persistent dismissals + review UX (`[e]xplain`, leverage header, first example)

**Files:**
- Create: `src/core/dismiss.ts`
- Modify: `src/commands/review.ts`
- Test: `src/core/dismiss.test.ts`, `src/commands/review.test.ts`

**Interfaces:**
- Consumes: `Suggestion.sourceSignatures` (Task 4), `gradientDir`.
- Produces in `dismiss.ts`: `interface Dismissal { id: string; name: string; signatures: string[]; dismissedAt: string }`; `loadDismissed(projectDir: string): Promise<Dismissal[]>` (absent/corrupt → `[]`); `addDismissal(projectDir: string, s: Suggestion): Promise<void>`; `isDismissed(s: Suggestion, dismissed: Dismissal[]): boolean` (subset rule). Tasks 11 and 12 import all three.
- Produces in `review.ts`: dismissed suggestions filtered out; `skip` persists a dismissal; prompter shows `≈ Xm/month`, the first example, and an `[e]xplain` loop.

- [ ] **Step 1: Write the failing tests**

Create `src/core/dismiss.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDismissed, addDismissal, isDismissed } from "./dismiss.js";
import type { Suggestion } from "./types.js";

const sug = (over: Partial<Suggestion>): Suggestion => ({
  id: "abc123", name: "approve", title: "t", rationale: "r",
  evidence: { count: 6, sessions: 3 }, confidence: "high",
  sourceSignatures: ["lgtm", "looks good"],
  payload: { type: "command", commandName: "approve", body: "x" },
  ...over,
});

describe("dismissals", () => {
  it("persists a dismissal and suppresses via the signature-subset rule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-dismiss-"));
    await addDismissal(dir, sug({}));
    const dismissed = await loadDismissed(dir);
    expect(dismissed[0]).toMatchObject({ id: "abc123", name: "approve", signatures: ["lgtm", "looks good"] });
    expect(isDismissed(sug({}), dismissed)).toBe(true);
    // same habit under a different LLM name / id, same signatures → still dismissed
    expect(isDismissed(sug({ id: "zzz999", name: "sign-off" }), dismissed)).toBe(true);
  });
  it("resurfaces when genuinely new evidence joins the cluster", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-dismiss-"));
    await addDismissal(dir, sug({}));
    const dismissed = await loadDismissed(dir);
    const grown = sug({ sourceSignatures: ["lgtm", "looks good", "ship it"] });
    expect(isDismissed(grown, dismissed)).toBe(false);   // "ship it" is new
  });
  it("falls back to id matching for suggestions without sourceSignatures (old caches)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-dismiss-"));
    await addDismissal(dir, sug({ sourceSignatures: undefined }));
    const dismissed = await loadDismissed(dir);
    expect(isDismissed(sug({ sourceSignatures: undefined }), dismissed)).toBe(true);
  });
  it("treats a corrupt dismissed.json as empty instead of crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-dismiss-"));
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "dismissed.json"), "{ nope");
    expect(await loadDismissed(dir)).toEqual([]);
  });
});
```

Append to `src/commands/review.test.ts`:

```ts
import { loadDismissed } from "../core/dismiss.js";

  it("records a skip as a persistent dismissal and hides it on the next run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-"));
    await seed(dir, ["ship", "plan"]);
    await review(dir, async (s) => (s.name === "ship" ? "skip" : "quit"));
    expect((await loadDismissed(dir)).map(d => d.name)).toEqual(["ship"]);
    const seen: string[] = [];
    await review(dir, async (s) => { seen.push(s.name); return "quit"; });
    expect(seen).toEqual(["plan"]); // ship no longer offered
  });
```

(also update `mk` in review.test.ts to include `sourceSignatures: [name]` so the subset rule has a key:)

```ts
const mk = (name: string): Suggestion => ({
  id: `id-${name}`, name, title: "t", rationale: "r",
  evidence: { count: 3, sessions: 2 }, confidence: "high",
  sourceSignatures: [name],
  payload: { type: "command", commandName: name, body: "do it" },
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/dismiss.test.ts src/commands/review.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/core/dismiss.ts`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gradientDir } from "./manifest.js";
import type { Suggestion } from "./types.js";

export interface Dismissal { id: string; name: string; signatures: string[]; dismissedAt: string }

function dismissedPath(projectDir: string): string {
  return join(gradientDir(projectDir), "dismissed.json");
}

/** Absent or corrupt → empty. Worst case is a re-shown suggestion, not data loss. */
export async function loadDismissed(projectDir: string): Promise<Dismissal[]> {
  try {
    const parsed = JSON.parse(await readFile(dismissedPath(projectDir), "utf8"));
    return Array.isArray(parsed) ? (parsed as Dismissal[]) : [];
  } catch {
    return [];
  }
}

export async function addDismissal(projectDir: string, s: Suggestion): Promise<void> {
  const entries = await loadDismissed(projectDir);
  entries.push({ id: s.id, name: s.name, signatures: s.sourceSignatures ?? [], dismissedAt: new Date().toISOString().slice(0, 10) });
  await mkdir(gradientDir(projectDir), { recursive: true });
  await writeFile(dismissedPath(projectDir), JSON.stringify(entries, null, 2));
}

/**
 * Subset rule: suppressed when every source signature was already dismissed —
 * genuinely new evidence (a new phrasing joining the cluster) resurfaces it.
 * Suggestions without signatures (old caches) fall back to id equality.
 */
export function isDismissed(s: Suggestion, dismissed: Dismissal[]): boolean {
  const sigs = s.sourceSignatures ?? [];
  if (!sigs.length) return dismissed.some(d => d.id === s.id);
  const union = new Set(dismissed.flatMap(d => d.signatures));
  return sigs.every(sig => union.has(sig));
}
```

`src/commands/review.ts`:

```ts
import { createInterface } from "node:readline/promises";
import type { Suggestion } from "../core/types.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { loadSuggestions } from "./apply.js";
import { loadDismissed, addDismissal, isDismissed } from "../core/dismiss.js";

export type Prompter = (s: Suggestion, index: number, total: number) => Promise<"approve" | "skip" | "quit">;

export async function review(projectDir: string, prompt: Prompter): Promise<ApplyResult[]> {
  const dismissed = await loadDismissed(projectDir);
  const suggestions = (await loadSuggestions(projectDir)).filter(s => !isDismissed(s, dismissed));
  const out: ApplyResult[] = [];
  for (let i = 0; i < suggestions.length; i++) {
    const decision = await prompt(suggestions[i], i, suggestions.length);
    if (decision === "quit") break;
    if (decision === "approve") out.push(await applySuggestion(suggestions[i], projectDir));
    if (decision === "skip") await addDismissal(projectDir, suggestions[i]);
  }
  return out;
}

export function readlinePrompter(): Prompter {
  return async (s, index, total) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const est = s.evidence.estMinutesSavedPerMonth ?? 0;
      process.stdout.write(
        `\n(${index + 1}/${total})  ${s.name} · ${s.payload.type} · ≈ ${est}m/month (${s.evidence.count}× · ${s.evidence.sessions} sessions) · ${s.confidence}\n` +
        `  ${s.title}\n` +
        (s.examples?.[0] ? `  e.g. "${s.examples[0].slice(0, 70)}"\n` : ""),
      );
      for (;;) {
        const ans = (await rl.question("  [a]pprove [s]kip [e]xplain [q]uit › ")).trim().toLowerCase();
        if (ans === "a") return "approve";
        if (ans === "q") return "quit";
        if (ans === "e") {
          process.stdout.write(`  ${s.rationale}\n`);
          for (const ex of s.examples ?? []) process.stdout.write(`    · ${ex}\n`);
          continue;
        }
        return "skip";
      }
    } finally {
      rl.close();
    }
  };
}
```

- [ ] **Step 4: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS (existing review test still green — "plan": "skip" now also writes a dismissal, which that test does not assert against).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: persistent dismissals with signature-subset suppression + richer review prompt"
```

---

### Task 10: usage.json + stats realized value + prune advisory

**Files:**
- Create: `src/core/usage.ts`
- Modify: `src/commands/scan.ts` (write usage.json)
- Modify: `src/commands/stats.ts`
- Modify: `src/cli.ts:157-166` (stats output)
- Test: `src/core/usage.test.ts`, `src/commands/stats.test.ts`

**Interfaces:**
- Consumes: `CommandEvent[]` (Task 3), `ManifestEntry[]`, `loadManifest`.
- Produces in `usage.ts`: `interface UsageEntry { uses: number; lastUsed: string }`, `type UsageMap = Record<string, UsageEntry>`; `computeUsage(events: CommandEvent[], manifest: ManifestEntry[]): UsageMap`; `saveUsage(projectDir: string, usage: UsageMap): Promise<void>`; `loadUsage(projectDir: string): Promise<UsageMap>` (absent/corrupt → `{}`).
- Produces in `stats.ts`: `StatsReport` gains `realizedUses: number; unused: string[]`; `StatPattern` gains `estMinutesSavedPerMonth?: number`; patterns sorted leverage-first, count as tiebreak.

- [ ] **Step 1: Write the failing tests**

Create `src/core/usage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeUsage } from "./usage.js";
import type { CommandEvent, ManifestEntry } from "./types.js";

const ev = (command: string, ts: string): CommandEvent => ({ ts, sessionId: "s", project: "p", command });
const entry = (name: string, createdAt: string): ManifestEntry =>
  ({ name, type: "command", path: `.claude/commands/${name}.md`, createdAt, suggestionId: "x" });

describe("computeUsage", () => {
  it("counts invocations of manifest commands since their creation date", () => {
    const events = [
      ev("/ship", "2026-06-29T10:00:00Z"),   // before createdAt → ignored
      ev("/ship", "2026-07-01T10:00:00Z"),
      ev("/ship", "2026-07-02T10:00:00Z"),
      ev("/other", "2026-07-02T10:00:00Z"),  // not a gradient artifact → ignored
    ];
    const usage = computeUsage(events, [entry("ship", "2026-06-30")]);
    expect(usage).toEqual({ ship: { uses: 2, lastUsed: "2026-07-02T10:00:00Z" } });
  });
  it("reports zero-use artifacts (prune candidates)", () => {
    const usage = computeUsage([], [entry("dead", "2026-06-01")]);
    expect(usage).toEqual({ dead: { uses: 0, lastUsed: "" } });
  });
  it("ignores non-command artifact types", () => {
    const loopEntry: ManifestEntry = { name: "cont", type: "loop", path: "", createdAt: "2026-06-01", suggestionId: "y" };
    expect(computeUsage([], [loopEntry])).toEqual({});
  });
});
```

In `src/commands/stats.test.ts`: extend the first test and fix the zero-cache shape:

```ts
  it("reports realized usage and unused artifacts", async () => {
    const dir = await seed();
    await writeFile(join(dir, ".gradient", "usage.json"),
      JSON.stringify({ ship: { uses: 5, lastUsed: "2026-07-01T10:00:00Z" }, dead: { uses: 0, lastUsed: "" } }));
    const home = await mkdtemp(join(tmpdir(), "grad-stats-home-"));
    const report = await stats(dir, { home });
    expect(report.realizedUses).toBe(5);
    expect(report.unused).toEqual(["dead"]);
  });
```

and update the existing zero-cache assertion (line ~37) to:

```ts
    expect(report).toEqual({ total: 0, covered: 0, coveragePct: 0, sessionScanEnabled: false, realizedUses: 0, unused: [], patterns: [] });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/usage.test.ts src/commands/stats.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/core/usage.ts`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gradientDir } from "./manifest.js";
import type { CommandEvent, ManifestEntry } from "./types.js";

export interface UsageEntry { uses: number; lastUsed: string }
export type UsageMap = Record<string, UsageEntry>;

/** Invocations of gradient-generated commands, counted since each artifact's createdAt. */
export function computeUsage(events: CommandEvent[], manifest: ManifestEntry[]): UsageMap {
  const out: UsageMap = {};
  for (const e of manifest) {
    if (e.type !== "command") continue;
    const hits = events
      .filter(ev => ev.command.replace(/^\//, "") === e.name && ev.ts.slice(0, 10) >= e.createdAt)
      .map(ev => ev.ts)
      .sort();
    out[e.name] = { uses: hits.length, lastUsed: hits.length ? hits[hits.length - 1] : "" };
  }
  return out;
}

export async function saveUsage(projectDir: string, usage: UsageMap): Promise<void> {
  await mkdir(gradientDir(projectDir), { recursive: true });
  await writeFile(join(gradientDir(projectDir), "usage.json"), JSON.stringify(usage, null, 2));
}

export async function loadUsage(projectDir: string): Promise<UsageMap> {
  try {
    const parsed = JSON.parse(await readFile(join(gradientDir(projectDir), "usage.json"), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as UsageMap) : {};
  } catch {
    return {};
  }
}
```

`src/commands/scan.ts` — after the suggestions cache write:

```ts
import { loadManifest } from "../core/manifest.js";
import { computeUsage, saveUsage } from "../core/usage.js";
  await saveUsage(projectDir, computeUsage(events, await loadManifest(projectDir)));
```

(note: `gradientDir` import already exists in scan.ts; `projectDir` is in scope.)

`src/commands/stats.ts`:

```ts
import { loadUsage } from "../core/usage.js";

export interface StatPattern {
  name: string;
  count: number;
  sessions: number;
  estMinutesSavedPerMonth?: number;
  confidence: Confidence;
  covered: boolean;
}

export interface StatsReport {
  total: number;
  covered: number;
  coveragePct: number;
  sessionScanEnabled: boolean;
  realizedUses: number;
  unused: string[];
  patterns: StatPattern[];
}

// in stats():
  const usage = await loadUsage(projectDir);
  const realizedUses = Object.values(usage).reduce((n, u) => n + u.uses, 0);
  const unused = Object.entries(usage).filter(([, u]) => u.uses === 0).map(([name]) => name);

  const patterns: StatPattern[] = suggestions
    .map(s => ({
      name: s.name,
      count: s.evidence.count,
      sessions: s.evidence.sessions,
      estMinutesSavedPerMonth: s.evidence.estMinutesSavedPerMonth,
      confidence: s.confidence,
      covered: coveredIds.has(s.id),
    }))
    .sort((a, b) =>
      (b.estMinutesSavedPerMonth ?? 0) - (a.estMinutesSavedPerMonth ?? 0) || b.count - a.count);

  const total = patterns.length;
  const covered = patterns.filter(p => p.covered).length;
  const coveragePct = total === 0 ? 0 : Math.round((covered / total) * 100);
  return { total, covered, coveragePct, sessionScanEnabled: config.scanOnSessionStart === true, realizedUses, unused, patterns };
```

`src/cli.ts` stats case — after the coverage line:

```ts
        log(c.dim(`realized: ${r.realizedUses} invocation(s) of gradient commands`));
        for (const name of r.unused) log(`  ${c.muted(`unused artifact — consider:`)} ${c.violet(`gradient remove ${name}`)}`);
```

and the per-pattern line gains leverage:

```ts
          log(`  ${confidenceChip(p.confidence)} ${c.bold(p.name)}  ${c.dim(`(≈ ${p.estMinutesSavedPerMonth ?? 0}m/mo · ${p.count}× · ${p.sessions} sessions)`)}  ${p.covered ? c.ok("✓ automated") : c.muted("—")}`);
```

- [ ] **Step 4: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: track realized artifact usage; stats reports value and prune candidates"
```

---

### Task 11: `gradient session-start` — surface ≤1 suggestion, then detached rescan

**Files:**
- Create: `src/commands/sessionStart.ts`
- Modify: `src/core/validate.ts:3` (allowlist)
- Modify: `src/core/settings.ts` (`replacing` support)
- Modify: `src/commands/init.ts:49`
- Modify: `src/cli.ts` (command case)
- Test: `src/commands/sessionStart.test.ts`, `src/core/settings.test.ts`, `src/commands/init.test.ts`, `src/core/validate.test.ts`

**Interfaces:**
- Consumes: `loadSuggestions`, `loadManifest`, `loadDismissed`/`isDismissed` (Task 9), `spawnDetached`.
- Produces: `MIN_SURFACE_MINUTES = 5`; `sessionStart(projectDir: string, deps?: { log?: (s: string) => void; spawn?: (args: string[], projectDir: string) => void }): Promise<void>` — prints at most one line, always before spawning, never throws; `mergeHookIntoSettings(existing, event, command, replacing?: string[])` and `installHook(projectDir, event, command, replacing?: string[])`; init installs `gradient session-start` and migrates `gradient scan --detach`.

- [ ] **Step 1: Write the failing tests**

Create `src/commands/sessionStart.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionStart, MIN_SURFACE_MINUTES } from "./sessionStart.js";

async function seed(suggestions: unknown[], manifest: unknown[] = [], dismissed: unknown[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grad-ss-"));
  await mkdir(join(dir, ".gradient"), { recursive: true });
  await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify(suggestions));
  await writeFile(join(dir, ".gradient", "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(dir, ".gradient", "dismissed.json"), JSON.stringify(dismissed));
  return dir;
}
const sug = (name: string, est: number, id = `id-${name}`) => ({
  id, name, title: `Title of ${name}`, rationale: "r",
  evidence: { count: 9, sessions: 4, estMinutesSavedPerMonth: est }, confidence: "high",
  sourceSignatures: [name],
  payload: { type: "command", commandName: name, body: "x" },
});

describe("sessionStart", () => {
  it("prints exactly the top new suggestion, then spawns the rescan", async () => {
    const dir = await seed([sug("small", 6), sug("big", 40)]);
    const logs: string[] = [];
    const spawns: string[][] = [];
    await sessionStart(dir, { log: m => logs.push(m), spawn: (args) => spawns.push(args) });
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("Title of big");
    expect(logs[0]).toContain("gradient review");
    expect(spawns).toEqual([["scan"]]);
  });
  it("suppresses applied, dismissed, and below-floor suggestions", async () => {
    const dir = await seed(
      [sug("applied", 40), sug("dismissed", 30), sug("tiny", MIN_SURFACE_MINUTES - 1)],
      [{ name: "applied", type: "command", path: "p", createdAt: "2026-07-01", suggestionId: "id-applied" }],
      [{ id: "id-dismissed", name: "dismissed", signatures: ["dismissed"], dismissedAt: "2026-07-01" }],
    );
    const logs: string[] = [];
    await sessionStart(dir, { log: m => logs.push(m), spawn: () => {} });
    expect(logs).toEqual([]);
  });
  it("fails open: any error prints nothing and still exits cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-ss-empty-"));
    const logs: string[] = [];
    await expect(sessionStart(dir, { log: m => logs.push(m), spawn: () => { throw new Error("boom"); } }))
      .resolves.toBeUndefined();
    expect(logs).toEqual([]);
  });
});
```

Append to `src/core/settings.test.ts` (`describe("mergeHookIntoSettings")`):

```ts
  it("replaces a superseded hook command while merging the new one", () => {
    const existing = mergeHookIntoSettings({}, "SessionStart", "gradient scan --detach");
    const out = mergeHookIntoSettings(existing, "SessionStart", "gradient session-start", ["gradient scan --detach"]);
    const commands = out.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands).toEqual(["gradient session-start"]);
  });
```

Append to `src/core/validate.test.ts`:

```ts
  it("treats a SessionStart→session-start hook as runnable", () => {
    expect(KNOWN_SUBCOMMANDS.has("session-start")).toBe(true);
  });
```

In `src/commands/init.test.ts`, find the assertion that the installed hook command is `"gradient scan --detach"` and change the expected string to `"gradient session-start"`; add (self-contained — uses only `init` plus node fs/os/path, all already imported in that file; add any that are missing):

```ts
  it("migrates a pre-existing scan --detach hook to session-start", async () => {
    const home = await mkdtemp(join(tmpdir(), "grad-init-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "grad-init-proj-"));
    await mkdir(join(projectDir, ".claude"), { recursive: true });
    await writeFile(join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "gradient scan --detach" }] }] } }));
    await init({ installSkill: false, sessionScan: true, home, projectDir }, { backend: null });
    const settings = JSON.parse(await readFile(join(projectDir, ".claude", "settings.json"), "utf8"));
    const commands = settings.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands).toEqual(["gradient session-start"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/commands/sessionStart.test.ts src/core/settings.test.ts src/core/validate.test.ts src/commands/init.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `src/commands/sessionStart.ts`:

```ts
import { loadSuggestions } from "./apply.js";
import { loadManifest } from "../core/manifest.js";
import { loadDismissed, isDismissed } from "../core/dismiss.js";
import { spawnDetached } from "../core/spawn.js";

export const MIN_SURFACE_MINUTES = 5;

/**
 * SessionStart hook target. Prints AT MOST one line (hook stdout lands in the
 * session context) from the existing cache — never scans inline — then spawns
 * the detached rescan. Hard fail-open: session start is never blocked.
 */
export async function sessionStart(
  projectDir: string,
  deps: { log?: (s: string) => void; spawn?: (args: string[], projectDir: string) => void } = {},
): Promise<void> {
  const log = deps.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const spawn = deps.spawn ?? spawnDetached;
  try {
    const [suggestions, manifest, dismissed] = await Promise.all([
      loadSuggestions(projectDir),
      loadManifest(projectDir),
      loadDismissed(projectDir),
    ]);
    const appliedIds = new Set(manifest.map(m => m.suggestionId));
    const appliedNames = new Set(manifest.map(m => m.name));
    const fresh = suggestions.filter(s =>
      !appliedIds.has(s.id) && !appliedNames.has(s.name) && !isDismissed(s, dismissed) &&
      (s.evidence.estMinutesSavedPerMonth ?? 0) >= MIN_SURFACE_MINUTES);
    if (fresh.length) {
      const top = fresh.reduce((a, b) =>
        (b.evidence.estMinutesSavedPerMonth ?? 0) > (a.evidence.estMinutesSavedPerMonth ?? 0) ? b : a);
      log(`gradient: "${top.title}" ≈ ${top.evidence.estMinutesSavedPerMonth}m/month (seen ${top.evidence.count}×) — run \`gradient review\` to adopt it.`);
    }
  } catch { /* fail-open — surfacing is best-effort */ }
  try {
    spawn(["scan"], projectDir);
  } catch { /* fail-open — background rescan is best-effort */ }
}
```

`src/core/validate.ts`:

```ts
export const KNOWN_SUBCOMMANDS: ReadonlySet<string> = new Set(["checkpoint", "scan", "session-start"]);
```

`src/core/settings.ts` — optional `replacing`:

```ts
export function mergeHookIntoSettings(
  existing: Record<string, any>,
  event: string,
  command: string,
  replacing: string[] = [],
): Record<string, any> {
  const out = { ...existing, hooks: { ...(existing.hooks ?? {}) } };
  let groups: HookGroup[] = Array.isArray(out.hooks[event]) ? [...out.hooks[event]] : [];
  if (replacing.length) {
    groups = groups
      .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !replacing.includes(h.command)) }))
      .filter(g => g.hooks.length > 0);
  }
  const already = groups.some(g => g.hooks?.some(h => h.command === command));
  if (!already) groups.push({ hooks: [{ type: "command", command }] });
  out.hooks[event] = groups;
  return out;
}

export async function installHook(projectDir: string, event: string, command: string, replacing: string[] = []): Promise<string> {
  // …unchanged body, except:
  const merged = mergeHookIntoSettings(existing, event, command, replacing);
```

`src/commands/init.ts:49`:

```ts
    await installHook(opts.projectDir ?? process.cwd(), "SessionStart", "gradient session-start", ["gradient scan --detach"]);
```

`src/cli.ts` — new case (before `default:`):

```ts
      case "session-start": {
        await sessionStart(projectDir, { log });
        return 0;
      }
```

(with `import { sessionStart } from "./commands/sessionStart.js";`. Do NOT add `session-start` to HELP — it is a hook target, internal like `checkpoint`.)

- [ ] **Step 4: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: session-start surfacing (≤1 suggestion) + detached rescan; migrate scan --detach hook"
```

---

### Task 12: The mirror — bare `gradient` + explain enrichment + docs

**Files:**
- Create: `src/commands/mirror.ts`
- Modify: `src/commands/scan.ts` (`onCandidates` dep)
- Modify: `src/cli.ts` (bare invocation, `help` case, explain output, HELP text)
- Modify: `README.md` (repo root) + `cli/README.md` quickstart
- Test: `src/commands/mirror.test.ts`, `src/cli.test.ts`

**Interfaces:**
- Consumes: `scan` + new `ScanDeps.onCandidates?: (cands: Candidate[]) => void`; `candidateLeverage` (Task 4); `loadDismissed`/`isDismissed` (Task 9); `loadSuggestions`.
- Produces: `MIRROR_MAX_AGE_MS = 86_400_000`; `mirror(projectDir: string, deps?: { log?: (s: string) => void; now?: number; scanFn?: typeof scan }): Promise<void>`. Bare TTY `gradient` runs the mirror; non-TTY keeps printing help; `gradient help` always prints help.

- [ ] **Step 1: Write the failing tests**

Create `src/commands/mirror.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirror } from "./mirror.js";

const sug = (name: string, est: number) => ({
  id: `id-${name}`, name, title: `Title ${name}`, rationale: "r",
  evidence: { count: 5, sessions: 3, estMinutesSavedPerMonth: est }, confidence: "high",
  sourceSignatures: [name],
  payload: { type: "command", commandName: name, body: "x" },
});

describe("mirror", () => {
  it("prints top suggestions from a fresh cache without rescanning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-mirror-"));
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([sug("ship", 40), sug("plan", 10)]));
    const logs: string[] = [];
    let scanned = false;
    await mirror(dir, { log: m => logs.push(m), scanFn: (async () => { scanned = true; return []; }) as any });
    expect(scanned).toBe(false);                       // cache is fresh (just written)
    expect(logs.join("\n")).toContain("Title ship");
    expect(logs.join("\n")).toContain("gradient review");
  });
  it("rescans user scope when the cache is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-mirror-empty-"));
    let scannedScope = "";
    await mirror(dir, { log: () => {}, scanFn: (async (opts: any) => { scannedScope = opts.scope; return []; }) as any });
    expect(scannedScope).toBe("all");                  // --user resolves to all-projects + window
  });
  it("hides dismissed suggestions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grad-mirror-dis-"));
    await mkdir(join(dir, ".gradient"), { recursive: true });
    await writeFile(join(dir, ".gradient", "suggestions.json"), JSON.stringify([sug("ship", 40)]));
    await writeFile(join(dir, ".gradient", "dismissed.json"),
      JSON.stringify([{ id: "id-ship", name: "ship", signatures: ["ship"], dismissedAt: "2026-07-01" }]));
    const logs: string[] = [];
    await mirror(dir, { log: m => logs.push(m), scanFn: (async () => []) as any });
    expect(logs.join("\n")).not.toContain("Title ship");
  });
});
```

Append to `src/cli.test.ts` (`describe("main")`):

```ts
  it("prints help for the explicit help command", async () => {
    const logs: string[] = [];
    const code = await main(["help"], { log: (m) => logs.push(m) });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Usage:");
  });
```

(the existing "returns 0 and prints help for no command" test keeps passing: vitest's stdout is not a TTY, so the bare invocation keeps the help path.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/commands/mirror.test.ts src/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/commands/scan.ts` — add to `ScanDeps` and call site:

```ts
import type { Candidate } from "../core/types.js";
// ScanDeps gains:
  /** Called with the clustered candidates before the LLM step (the mirror's instant headline). */
  onCandidates?: (cands: Candidate[]) => void;
// in scan(), after markCorrections(candidates):
  deps.onCandidates?.(candidates);
```

Create `src/commands/mirror.ts`:

```ts
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { gradientDir } from "../core/manifest.js";
import { loadSuggestions } from "./apply.js";
import { loadDismissed, isDismissed } from "../core/dismiss.js";
import { candidateLeverage } from "../core/leverage.js";
import { resolveScanScope } from "../core/scope.js";
import { loadConfig } from "../config.js";
import { scan } from "./scan.js";
import { c } from "../core/ui.js";
import type { Candidate } from "../core/types.js";

export const MIRROR_MAX_AGE_MS = 86_400_000; // 24h

/**
 * The bare-`gradient` first-contact experience: time-saved headline (local,
 * printed as soon as clustering finishes), then the top cached suggestions.
 */
export async function mirror(
  projectDir: string,
  deps: { log?: (s: string) => void; now?: number; scanFn?: typeof scan } = {},
): Promise<void> {
  const log = deps.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const now = deps.now ?? Date.now();
  const scanFn = deps.scanFn ?? scan;

  let fresh = false;
  try {
    fresh = now - (await stat(join(gradientDir(projectDir), "suggestions.json"))).mtimeMs < MIRROR_MAX_AGE_MS;
  } catch { /* no cache yet */ }

  if (!fresh) {
    const config = await loadConfig();
    const resolved = resolveScanScope({ user: true }, config);
    log(c.dim(`first look — scanning ${resolved.label}`));
    await scanFn(
      { scope: resolved.scope, projectPath: projectDir, sinceDays: resolved.sinceDays },
      {
        config,
        log: () => {},
        onCandidates: (cands: Candidate[]) => {
          const top = [...cands].sort((a, b) => candidateLeverage(b) - candidateLeverage(a)).slice(0, 5);
          if (!top.length) return;
          log(c.bold("\nyour most repeated patterns:"));
          for (const cd of top) {
            log(`  ${c.muted(cd.signature.slice(0, 56))}  ${c.dim(`${cd.count}× · ≈ ${candidateLeverage(cd)}m/month`)}`);
          }
          log(c.dim("\nrefining into suggestions…"));
        },
      },
    );
  }

  const dismissed = await loadDismissed(projectDir);
  const suggestions = (await loadSuggestions(projectDir)).filter(s => !isDismissed(s, dismissed)).slice(0, 3);
  if (!suggestions.length) {
    log(c.dim("no suggestions yet — try `gradient scan --all` for full history"));
    return;
  }
  log(c.bold("\ntop suggestions:"));
  for (const s of suggestions) {
    log(`  ${c.bold(s.name)}  ${c.muted(s.title)}  ${c.dim(`≈ ${s.evidence.estMinutesSavedPerMonth ?? 0}m/month`)}`);
  }
  log(`\n${c.dim("Next:")} ${c.violet("gradient review")}`);
}
```

`src/cli.ts`:

```ts
import { mirror } from "./commands/mirror.js";
// bare invocation:
  if (argv.length === 0) {
    if (!process.stdout.isTTY) {   // scripts/CI: never trigger a scan by accident
      log(`${banner(VERSION)}\n\n${HELP}`);
      return 0;
    }
    log(banner(VERSION));
    await mirror(projectDir, { log });
    return 0;
  }
// new case beside the others:
      case "help": {
        log(`${banner(VERSION)}\n\n${HELP}`);
        return 0;
      }
```

explain case — after the examples loop:

```ts
        const est = s.evidence.estMinutesSavedPerMonth;
        if (est !== undefined) log(c.dim(`≈ ${est}m/month (count × per-occurrence cost, normalized to 30 days)`));
        const t = s.evidence.temporal;
        if (t) log(c.dim(`temporal: runs up to ${t.maxRunLength}/session · median gap ${t.medianGapMinutes}m · ${t.distinctDays} day(s) over ${t.spanDays}`));
```

HELP text — first usage line becomes:

```
Usage:
  gradient                      the mirror: your repeated patterns + top suggestions
  gradient init                 configure + install the /gradient skill
  …
  gradient help                 show this help
```

`README.md` (repo root) Quickstart — prepend:

```bash
npx gradient             # the mirror: your repeated patterns, priced in minutes/month
```

and make the same edit in `cli/README.md` if it repeats the quickstart block.

- [ ] **Step 4: Run full gate**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): bare-gradient mirror, help command, leverage-aware explain"
```

---

## Post-plan: whole-branch review

After Task 12, run the house closing routine (as Spec 1 did): whole-branch review against `main` (base = the branch point), full suite + typecheck on the merged result, then merge per the user's call. Spec §8's cleanup items should all be verifiably done by the tasks above:

- count-sort removed (Task 4), LLM-name ids removed (Task 4), `<command-name>` filter pattern deleted (Task 3), `degradeToCommands` replaced (Task 5), old SessionStart hook migrated (Task 11), README/HELP updated (Task 12), `parse.ts` header comment updated (Task 3).

## Self-review notes (already applied)

- Spec §3.1 "review order" needs no separate change: review reads the cache, and Tasks 4/5 sort the cache leverage-descending at write time.
- Spec §3.4's dismissal file "printed warning on corrupt" was simplified to silent-empty in `loadDismissed` — a warning would leak into `session-start` hook stdout (which lands in the session context). The fail-open path (worst case: a re-shown suggestion) is the safer default; noted here as a deliberate deviation.
- `evidence.estMinutesSavedPerMonth` / `sourceSignatures` / `temporal` optional (not required as spec §4 sketched) — keeps old caches and every existing Suggestion fixture compiling; all display sites use `?? 0` or conditional print.
- The deterministic `hookFromEvents` suggestion bypasses the LLM entirely and is deduped by stable id in scan, so it also works in degraded mode (spec Decision 6's "degraded path emits hooks").
