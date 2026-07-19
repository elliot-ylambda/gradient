# gradient — Tailored Suggestions & Feedback Flywheel: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement spec `docs/superpowers/specs/2026-07-01-gradient-suggestion-flywheel-design.md` — leverage-ranked suggestions, temporal loop/hook evidence, corrections→preference rules (main's `.claude/rules/` mechanism), and the dismissal/surfacing flywheel. (Revised 2026-07-18 against main@44d4af0 — see Revision log at the bottom.)

**Architecture:** Everything extends the existing `scan` pipeline (`collect → parse → filter → cap → cluster/paste/answers/sequences → detect → validate → cache`) plus the CLI commands around it. New pure core modules (`temporal`, `leverage`, `classify`, `corrections`, `dismiss`) slot between existing stages; two new commands (`session-start`, the bare-invocation mirror) reuse them. No new subsystem, no new dependency.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node ≥ 20, vitest 2, zero new runtime deps.

## Global Constraints

- Branch: `spec/suggestion-flywheel`, in the worktree `.claude/worktrees/suggestion-flywheel` (rebased onto main@44d4af0; baseline 609 tests + typecheck clean); commit per task.
- All commands below run from the worktree's `cli/` directory.
- Implementers MUST read the current-main files a task touches before writing — the code this plan was originally written against no longer exists; the requirement specs below are the contract, current main is the substrate.
- House rules (from v1/Spec 1, still binding): every string sent to an LLM passes `redact()` first; no silent failures (background paths log to `.gradient/last-scan.log`); emitted hooks call a `gradient` subcommand, never inline shell; never rewrite a file that failed to parse (corrupt-settings precedent, `settings.ts:31`); writes stay inside `.claude/` (rules are standalone `.claude/rules/gradient-*.md` files — gradient never edits CLAUDE.md).
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

### Task 3: CommandEvents — parse `<command-name>` turns as structured events

> Revised 2026-07-18. Main now has THREE consumers that scrape `<command-name>` tags
> from raw turns with ad-hoc regexes: `core/usage.ts:22-31` (adoption counting),
> `core/insights.ts:46-52` (compact/model-switch metrics), and the filter that
> discards these turns from mining (`core/filter.ts:6`). This task replaces the
> scrape-and-discard pattern with one structured extraction at parse time.

**Files:** modify `src/core/types.ts` (CommandEvent), `src/core/parse.ts`, `src/core/filter.ts`, `src/core/usage.ts`, `src/core/insights.ts`, `src/commands/scan.ts`, `src/commands/stats.ts` (if it feeds usage from turns); tests co-located with each.

**Requirements:**
1. `types.ts`: `interface CommandEvent { ts: string; sessionId: string; project: string; command: string }`.
2. `parse.ts`: `interface ParsedTranscript { turns: Turn[]; events: CommandEvent[] }`; `parseTranscript(lines)` routes turns whose text matches `/^\s*<command-name>([^<]+)<\/command-name>/` into `events` (command = trimmed capture) and everything else into `turns`; `parseTranscriptFile(path)` async wrapper. Existing `parseLines`/`parseFile` become turn-only wrappers so current callers keep compiling. A prompt merely starting with a non-command tag (e.g. `<div>`) stays a turn.
3. `filter.ts`: delete the `/^<command-(name|message|args)/i` entry from `INJECTED_PATTERNS` (those turns no longer reach filter). Keep the bare-slash rule (`/^\/[\w:-]+$/`) — a typed `/foo` with no tag wrapper is still filtered as already-automated.
4. Migrate the scrapers: `usage.ts` `countArtifactUses` takes `CommandEvent[]` instead of turns (delete its local `COMMAND_RE`); `insights.ts` command-tag metrics likewise consume events. Trace their callers (`stats.ts`, `cli.ts`, `commands/insights.ts` if any) and thread events through — no caller may silently lose data because command turns vanished from `turns`.
5. `scan.ts`: `ScanDeps.parseFn` type becomes `(path) => Promise<ParsedTranscript>`; scan accumulates `events` alongside turns (codex parsers are untouched — codex transcripts have no command tags; their ParsedTranscript has `events: []` or the codex path keeps its own types). Update every scan.test.ts parseFn stub to the new shape.
6. Regression: parse fixtures with a `<command-name>/compact</command-name>...` turn assert it lands in events (not turns, not filtered); usage/insights tests keep passing with events-based input.

Gate: `npm test && npm run typecheck` from `cli/`. Commit: `feat(core): parse slash-command invocations as structured events (was: scraped and filtered)`.

---

### Task 4: `core/leverage.ts` + stable ids + `sourceSignatures` + leverage ordering in detect

> Revised 2026-07-18. Main's `Suggestion.id` is `hashId(sourceIds.join()+type)`
> (`detect.ts:345`) where each `candidateRef` folds in the candidate's **rank index
> and sessionIds** (`detect.ts:33-35`) — so ids change whenever the corpus grows.
> Ranking is by raw count (`detect.ts:236`). This task makes ids stable across runs
> and ranks by estimated time saved. `candidateRef` itself stays unchanged (opaque
> wire token; its instability doesn't matter — it never leaves the process).

**Files:** create `src/core/leverage.ts`; modify `src/core/types.ts`, `src/core/detect.ts`, `src/cli.ts` (scan print gains `≈Xm/mo`); tests `src/core/leverage.test.ts`, `src/core/detect.test.ts`.

**Requirements:**
1. `leverage.ts`: `TYPING_CPS = 3.3`, `ROUND_TRIP_S = 15`, `CORRECTION_S = 60`; `type LeverageKind = "command" | "loop" | "hook" | "rule"`; `estMinutesSavedPerMonth({ count, chars, spanDays, kind }): number` — perOccurrence seconds = `chars/TYPING_CPS + ROUND_TRIP_S` (command/loop/hook) or `CORRECTION_S` (rule); monthly = `count × perOcc/60 × 30/max(spanDays, 7)`, rounded to integer. Anchor test: 12×66-char command over 30 days → 7. `candidateLeverage(c: Candidate): number` uses `spanDays(c.occurrences)` (from `temporal.js`) and mean example length; kind mapping: answer→rule, everything else→command.
2. `types.ts`: `Suggestion.sourceSignatures?: string[]`; evidence becomes `{ count; sessions; assistants?; estMinutesSavedPerMonth?: number; temporal?: TemporalFeatures }` (new fields optional — old caches/fixtures stay valid).
3. `detect.ts`: exported `idFor(sigs: string[]): string` = `hashId` of the sorted, deduped signature list joined with ` ` plus the payload type; LLM path (`detect.ts:345`) and degrade path (`detect.ts:128`) both use it with the union of matched candidates' `memberSignatures` (fallback `[signature]` when empty). Module-private `evidenceFor(matched, payloadType)` builds evidence including `estMinutesSavedPerMonth` and, when any matched candidate has `temporal`, the temporal of the highest-count one. Every produced Suggestion carries `sourceSignatures` (the same redacted signature union). Ranking: `detect.ts:236` sorts by `candidateLeverage` descending (count as tiebreak); returned suggestions sorted by `evidence.estMinutesSavedPerMonth` descending via exported `byLeverage` comparator.
4. Regression: same corpus scanned twice (different candidate order in the second call) yields identical suggestion ids; a run where the LLM renames a suggestion keeps its id.

Gate + commit: `feat(core): leverage estimates, stable signature-derived ids, leverage-ranked detect`.

---

### Task 5: Deterministic loop/schedule/hook classification

> Revised 2026-07-18. Main's loops are purely LLM-chosen (`detect.ts:303-309`); the
> only permitted hook is PreCompact/checkpoint (`detect.ts:311-317`, a house
> guardrail — keep it). Temporal features (Task 2) and CommandEvents (Task 3) now
> make loop/schedule/hook evidence computable locally.

**Files:** create `src/core/classify.ts`; modify `src/core/types.ts` (`Candidate.cadence?: string`), `src/core/detect.ts`, `src/commands/scan.ts`; tests `src/core/classify.test.ts`, `src/core/detect.test.ts`.

**Requirements:**
1. `classify.ts`: `LOOP_MIN_RUN = 3`, `LOOP_MIN_RUN_SESSIONS = 2`, `SCHEDULE_MIN_DAYS = 5`, `HOOK_MIN_COUNT = 10`, `HOOK_MIN_SESSIONS = 3`. `markLoops(candidates): void` — sets `kind = "loop"` on kind-"unknown" candidates with `temporal.maxRunLength ≥ LOOP_MIN_RUN && temporal.runSessions ≥ LOOP_MIN_RUN_SESSIONS`; additionally sets `cadence` via `deriveDailyCadence(c)` when `temporal.distinctDays ≥ SCHEDULE_MIN_DAYS` (e.g. "daily" / "most weekdays" from distinctDays/spanDays ratio). `hookFromEvents(events: CommandEvent[]): Suggestion | null` — when `/compact` events reach `HOOK_MIN_COUNT` across `HOOK_MIN_SESSIONS` sessions, return the PreCompact/checkpoint hook suggestion (same payload shape as `detect.ts:312-317`), id via `idFor(["/compact"])`-style stable derivation, evidence from the events; else null.
2. `detect.ts`: exported `candidateToLoop(c): Suggestion` (locally reconstructed instruction from the signature with `AUTHORIZATION_GUARD`, cadence passthrough, `CONSEQUENTIAL_ACTION` guard → falls back to command). Degrade path (`degradeToCommands`) emits loops for loop-kind candidates plus commands as today. LLM path: loop-kind candidates the model's response didn't claim get `candidateToLoop` appended (the model may still merge/override them; deterministic evidence must not be lost when the model ignores it). `kindsAreCompatible` already permits loop for non-special kinds — verify with a test that a marked loop candidate the LLM calls a command still passes.
3. `scan.ts`: call `markLoops(allCandidates)` after `annotateTemporal`; after detect, append `hookFromEvents(events)` when non-null and no equal-id suggestion exists (works in degraded/no-LLM mode too — spec Decision 6).
4. Regression fixtures: a "continue"-style cluster with runs (maxRunLength 4, runSessions 3) becomes a loop suggestion with zero LLM involvement; 12 `/compact` events across 4 sessions produce the PreCompact hook suggestion in degraded mode.

Gate + commit: `feat(core): deterministic loop/schedule/hook classification from temporal + command evidence`.

---

### Task 6: DROPPED — superseded by main's `rule` payload

The planned `claude-md` payload (managed CLAUDE.md block) conflicts with a design
decision that landed on main while this branch was in flight: gradient **never
edits CLAUDE.md** (`emit/rule.ts:9-13` prints user-target rules; project rules are
standalone `.claude/rules/gradient-<name>.md` files with provenance markers,
removable via the manifest). Corrections (Task 7) therefore synthesize into the
existing `rule` payload instead. No work in this task.

---

### Task 7: Corrections mining → rule synthesis

> Revised 2026-07-18: emits main's `rule` payload (`.claude/rules/`), not the
> dropped `claude-md` payload. Distinct from `answers.ts` (repeated answers to the
> assistant's questions): corrections are unprompted user pushback.

**Files:** create `src/core/corrections.ts`; modify `src/core/types.ts` (kind union + "correction"), `src/core/detect.ts`, `src/core/leverage.ts` (correction branch prices at `CORRECTION_S`), `src/commands/scan.ts`; tests `src/core/corrections.test.ts`, `src/core/detect.test.ts`.

**Requirements:**
1. `corrections.ts`: `isCorrectionShaped(normalized: string): boolean` — matches correction openers/patterns: `no,`/`no `, `don't …`, `stop …ing`, `actually …`, `i told you …`, `you didn't …`, `wrong …`, `never …`, `use X not Y`. Negative cases: plain imperatives ("push and create a pull request", "continue", "write the implementation plan"). `markCorrections(candidates): void` sets `kind = "correction"` on kind-"unknown" candidates whose signature is correction-shaped with `count ≥ 3 && sessions ≥ 2`.
2. `detect.ts`: `kindsAreCompatible` — kind "correction" is special like "answer": only payload `rule`. System prompt gains one sentence: a 'correction' cluster must become a low-impact preference rule; it never removes confirmation for consequential actions. Local rule text for correction candidates (the `answer ← question` `ruleText` split doesn't apply): a fixed template quoting the redacted signature — "Repeated correction observed: <signature>. Follow this preference for low-impact choices. This preference is not authorization: …" (reuse the existing authorization tail from `ruleText`, `detect.ts:216-219`). Degrade path excludes corrections (rules need judgment; never auto-emit without the LLM naming them).
3. `scan.ts`: `markCorrections(allCandidates)` after `markLoops`.
4. Regression: cluster "don't add comments" (4×, 3 sessions) → rule suggestion targeting `.claude/rules/`, correction-shaped text, priced via `CORRECTION_S`.

Gate + commit: `feat(core): mine correction habits into preference rules`.

---

### Task 8: Post-merge pass — near-duplicate suggestions merge in code

> Revised 2026-07-18. Main's merging is LLM-driven via `sourceIds` grouping; when
> the model returns two suggestions for one habit (dogfood case: lgtm vs
> looks-good) nothing consolidates them. CAUTION: every command body now begins
> with the fixed ~300-char `AUTHORIZATION_GUARD` — similarity must be computed on
> the **distinctive** text only (name + triggers + the observed instruction /
> signature), never the full body, or everything merges.

**Files:** modify `src/core/detect.ts`; tests `src/core/detect.test.ts`.

**Requirements:**
1. Exported `mergeNearDuplicates(suggestions, bySignature: Map<string, Candidate>): Suggestion[]`: hosts ordered by `byLeverage`; a suggestion merges into the first host with the same `payload.type` and `similarity(mergeText(a), mergeText(b)) ≥ 0.6` (trigram similarity from `cluster.js`). `mergeText` = `normalize(name + " " + distinctive text)` where distinctive text is triggers/commandName for commands, instruction minus the guard prefix for loops, ruleName+text minus the authorization tail for rules, description for hooks. On merge: union `sourceSignatures`; when every signature resolves in `bySignature`, recompute evidence via `evidenceFor` and id via `idFor`; union examples (cap 5). Unresolvable union → keep host unchanged, drop duplicate.
2. LLM path returns `mergeNearDuplicates(out, bySignature).sort(byLeverage)`; `bySignature` maps every top-candidate memberSignature → candidate. Degrade path stays unmerged (one-per-signature by construction).
3. Regression (the dogfood fixture): LLM returns separate "lgtm" (3×, s1+s2) and "looks good" (3×, s2+s3) command suggestions with near-identical distinctive text → one suggestion, count 6, sessions 3, sourceSignatures {lgtm, looks good}. Counter-test: a loop and a command over similar text do NOT merge. Guard test: two unrelated commands (different triggers/instructions) sharing only the AUTHORIZATION_GUARD boilerplate do NOT merge.

Gate + commit: `fix(core): deterministic post-merge of near-duplicate suggestions (llm merge is a hint, not a guarantee)`.

---

### Task 9: Persistent dismissals + review UX

> Revised 2026-07-18. Main's review prompter returns `approve | skip | quit`
> (`review.ts:12-17`); skip is session-only — the suggestion returns forever.
> `specs/2026-07-09-gradient-review-clarify-design.md:20` explicitly deferred
> dismissals to this branch. Preserve the clarify flow (`review.ts:100-103`).

**Files:** create `src/core/dismiss.ts`; modify `src/commands/review.ts`; tests `src/core/dismiss.test.ts`, `src/commands/review.test.ts`.

**Requirements:**
1. `dismiss.ts`: `interface Dismissal { id: string; name: string; signatures: string[]; dismissedAt: string }`; `loadDismissed(projectDir)` reads `.gradient/dismissed.json`, absent/corrupt → `[]` (silent — a warning would leak into session-start hook stdout; deliberate, documented deviation); `addDismissal(projectDir, s)` appends (signatures from `s.sourceSignatures ?? []`); `isDismissed(s, dismissed)` — **signature-subset rule**: dismissed if some dismissal's signature set is a superset of the suggestion's `sourceSignatures` (a suggestion whose cluster gained a genuinely new signature resurfaces); fallback to id equality when the suggestion has no sourceSignatures (old caches).
2. `review.ts`: dismissed suggestions filtered out at load; choosing `skip` persists a dismissal (next `review` no longer offers it); prompter line gains `≈Xm/month` (when present) and the first example; add an `[e]xplain` action that prints rationale + examples + evidence then re-prompts. Keep approve/quit/clarify behavior byte-compatible otherwise.
3. Regression tests: subset-rule resurface case ({lgtm, looks good} dismissed; {lgtm, looks good, ship it} resurfaces); corrupt dismissed.json → `[]`; skip-then-rerun hides the suggestion.

Gate + commit: `feat: persistent dismissals with signature-subset resurfacing + review explain/leverage UX`.

---

### Task 10: stats — leverage-first ordering + realized-value line (SLIMMED)

> Revised 2026-07-18. The planned usage.json is DROPPED — main already counts
> adoption live from transcripts (`usage.ts` `countArtifactUses`, adoption ledger +
> `suggestRemoval` in `stats.ts:34-97`). What remains: stats should speak minutes,
> not just counts, closing the flywheel loop (scan estimates → stats proves).

**Files:** modify `src/commands/stats.ts`, `src/cli.ts` (stats print); tests `src/commands/stats.test.ts`.

**Requirements:**
1. Pending-suggestion listing in stats sorts by `evidence.estMinutesSavedPerMonth` descending (count as tiebreak), printing `≈Xm/mo` when present.
2. Adoption rows gain realized value: `uses × perOccurrence estimate` for that artifact (via leverage constants; command chars from the artifact's trigger/example length when available, else the ROUND_TRIP_S floor) printed as `≈Xm saved`. No new persistence.
3. Unused-artifact advisory (`suggestRemoval`) keeps working unchanged — regression-covered.

Gate + commit: `feat(stats): leverage-ordered suggestions and realized minutes-saved`.

---

### Task 11: `gradient session-start` — surface ≤1 suggestion, then detached rescan

> Revised 2026-07-18. Main's SessionStart story is a silent detached rescan:
> `init.ts:91,96` installs `gradient scan --detach`; `cli.ts:269-274` spawns and
> exits 0. This task makes session start *speak* — at most one line. NOTE: hook
> dispatch may route through `bin.ts` (fast dispatcher) — trace how the installed
> hook command reaches `cli.ts` and register `session-start` on that same path.

**Files:** create `src/commands/sessionStart.ts`; modify `src/core/settings.ts` (`replacing` support in `mergeHookIntoSettings`/`installHook`), `src/commands/init.ts`, `src/cli.ts` (+`bin.ts` if hooks dispatch there); validate allowlist if `KNOWN_SUBCOMMANDS` exists (`src/core/validate.ts`); tests for each.

**Requirements:**
1. `sessionStart(projectDir, deps?)`: `MIN_SURFACE_MINUTES = 5`. Reads suggestions cache + manifest + dismissals; picks the highest-`estMinutesSavedPerMonth` suggestion that is not applied (manifest), not dismissed, and ≥ MIN_SURFACE_MINUTES; prints exactly one line (title + `≈Xm/month` + `gradient review` pointer) or nothing; then spawns the detached rescan (existing `spawnDetached` path). Print always precedes spawn. Any error → print nothing, resolve cleanly (fail open; never break session start).
2. `mergeHookIntoSettings(existing, event, command, replacing?: string[])`: removes superseded commands while merging the new one; corrupt-settings precedent still holds (never rewrite a file that failed to parse, `settings.ts:31`).
3. `init` installs `gradient session-start` (migrating any existing `gradient scan --detach` hook via `replacing`); `cli.ts` gains the `session-start` case; validate allowlist updated.
4. Tests: top-suggestion line + spawn order; suppression (applied/dismissed/below-floor → silence); fail-open on thrown spawn; hook migration fixture (settings.json with the old command → only the new one remains).

Gate + commit: `feat: session-start surfaces the top suggestion (≤1 line) before the detached rescan`.

---

### Task 12: The mirror — bare `gradient` + docs

> Revised 2026-07-18. Bare `gradient` prints banner+HELP unconditionally
> (`cli.ts:215-218`). TTY invocation becomes the mirror; automation keeps help.

**Files:** create `src/commands/mirror.ts`; modify `src/cli.ts` (bare invocation TTY-gated, explicit `help` case, HELP text), `README.md` + `cli/README.md`; tests `src/commands/mirror.test.ts`, `src/cli.test.ts`.

**Requirements:**
1. `mirror(projectDir, deps?)`: `MIRROR_MAX_AGE_MS = 86_400_000`. Fresh cache (< max age): print top N (≤3) non-dismissed, non-applied suggestions with `≈Xm/mo` + a `gradient review` pointer, no rescan. Stale/missing cache: run a user-scope scan (scope "all" + recency window) first. Dismissed suggestions never shown.
2. `cli.ts`: bare `gradient` on a TTY runs mirror; non-TTY prints help exit 0 (unchanged behavior for scripts/CI); explicit `gradient help` always prints help. HELP text gains session-start/mirror lines.
3. READMEs: quickstart reflects the flywheel (init → work → session-start nudge → review → stats proves minutes saved). Keep gradient-web hero/feature-grid sync note in the PR description (site is a separate repo).
4. Tests: fresh-cache no-rescan; missing-cache user-scope rescan; dismissed hidden; `help` prints usage; non-TTY bare invocation prints help.

Gate + commit: `feat: bare gradient mirror + flywheel docs`.

---

## Post-plan: whole-branch review

After Task 12: whole-branch review against main (base = merge-base), full gate on the result, triage accumulated Minor findings, then superpowers:finishing-a-development-branch. Verify the Spec §8 cleanup items that survived the 2026-07-18 re-scope: count-sort removed (Task 4), unstable ids removed (Task 4), `<command-name>` scrapers unified on CommandEvents (Task 3), loop evidence deterministic (Task 5), SessionStart hook migrated (Task 11), README/HELP updated (Task 12).

## Revision log

- **2026-07-18** — Main moved +4,154 lines (auto-responder, 0.4.0) while Tasks 1–2 were in flight; branch rebased onto 44d4af0 (609-test baseline). Tasks 3–12 re-scoped against current main: Task 6 dropped (CLAUDE.md managed block superseded by the landed `.claude/rules/` design); Task 10 slimmed (usage.json superseded by live adoption counting); Tasks 3/4/5/7/8/9/11/12 re-anchored (new consumers to migrate, stable-id derivation now replaces `candidateRef`-based ids, AUTHORIZATION_GUARD excluded from merge similarity, review prompter/clarify preserved, bin.ts hook dispatch). Complete-code blocks were replaced by requirement specs — the code they were written against no longer exists; implementers TDD against current main.
- Earlier self-review notes (still binding): evidence fields optional; dismissal load silent-empty on corrupt; deterministic hook suggestion works in degraded mode.
