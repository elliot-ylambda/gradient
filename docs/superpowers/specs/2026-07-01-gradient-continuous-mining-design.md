# gradient — Continuous Mining & Scan Quality: Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming complete; implementation plan pending)
**Scope:** Second sub-project of `gradient`. Ships before the personalized
auto-responder (which gets its own later spec).

---

## 1. Context

v1 shipped the **analysis engine**: `scan` mines Claude Code history, clusters
repeated prompts locally, and an LLM formalizes the top candidates into
slash-commands / loops / hooks that the user reviews and applies
(`docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md`).

This spec sharpens that engine along four axes and adds one hands-off trigger. It
is deliberately the *smaller, lower-risk* of the two remaining roadmap pieces; the
**personalized auto-responder** (the phase-2 autopilot from the v1 spec §1) is
sequenced after it and specced separately.

The four components all touch the existing `scan` pipeline — no new subsystem:

1. **Semantic dedup** — collapse same-meaning habits (`lgtm` / `looks good` /
   `ship it`) into one suggestion, via the LLM call `detect` already makes.
2. **`stats` + `explain`** — two read-only commands over the existing cache.
3. **Opt-in session-start scan** — a config flag that installs a `SessionStart`
   hook running the existing `scan`. No incremental engine.
4. **`scan --all` scalability** — replace the O(b²) fuzzy-merge with minhash-LSH
   so full-history scans stop dropping old data.

---

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Sequencing | Ship this before the personalized auto-responder (Spec 2). |
| 2 | Scheduled scan | **Not** an incremental background engine. An opt-in `scanOnSessionStart` config flag installs a `SessionStart` hook that runs the existing `gradient scan`. No delta/notification/"seen"-state code. |
| 3 | Scan delivery | The session-start scan runs **non-blocking** (detached) so it never delays session start; it refreshes the suggestions cache in the background. |
| 4 | Semantic dedup | Fold "merge synonymous clusters" into the **existing `detect` LLM call**. No embeddings, no new dependency. The model returns `sourceSignatures[]`; `detect` sums occurrence counts and **unions session identities** across the merged clusters. |
| 5 | Scan scalability | Replace `cluster.ts` stage-2 O(b²) fuzzy-merge with **minhash-LSH banding**. `capByRecency` demotes from primary bound to a configurable safety ceiling (raised/off by default for `--all`). |
| 6 | New commands | `stats` and `explain`, both **read-only, no LLM**. |
| 7 | Bundling | All four components ship as **one** spec / plan. |

---

## 3. Components

### 3.1 Semantic dedup (in `core/detect.ts`)

Trigram clustering groups by shared characters, so `lgtm` and `looks good` never
merge despite identical intent. Meaning-level merging needs the model, and `detect`
already calls it — so the merge rides along in that one call.

- **Widen the candidate window.** `scan` currently shows `detect` the top ~12
  candidates. Near-duplicates can fill those 12 and crowd out distinct patterns
  *before* any merge happens. Widen the window fed to the model (target ~24;
  final number pinned in the plan against token cost) so synonyms and distinct
  patterns are both present to be merged/ranked.
- **Prompt change.** Instruct the model to group signatures that mean the same
  thing and emit **one** suggestion per group, returning the exact source
  signatures it merged.
- **Schema change.** Each returned suggestion carries `sourceSignatures: string[]`
  (was a single `sourceSignature`). `detect` maps each back to its `Candidate`
  and aggregates evidence:
  - `count` = **sum** of member counts (each occurrence is distinct → summing is
    correct).
  - `sessions` = size of the **union** of member session identities (summing the
    per-cluster session *counts* would double-count a session that contributed two
    different phrasings — so this must be a set union, see §4).
- **Privacy unchanged.** Only short, redacted signatures leave the machine, as
  today; the wider window sends a few more short strings, never transcripts.
- **Degradation unchanged.** With no LLM, `scan` still emits exact-repeat
  (`high`) commands with no merge — acceptable.
- **Robustness.** If a returned `sourceSignatures` entry is unknown, it is
  ignored; if all are unknown, the suggestion is treated as un-merged. Never
  throws — a malformed merge degrades, it does not crash the scan.

### 3.2 `stats` + `explain` (read-only, no LLM)

- **`gradient stats`** — from `.gradient/suggestions.json` + `.gradient/manifest.json`:
  the most-repeated patterns by frequency, **coverage** (share of surfaced
  suggestions that already have a generated artifact), and the active scope. Uses
  the existing `ui.ts` palette / confidence chips.
- **`gradient explain <id|name>`** — the evidence behind one suggestion: the
  representative example prompts, `count`, `sessions`, `confidence`, and
  `rationale`. Resolves by suggestion `id` or `name`.
- Both fail friendly when the cache is absent: *"no suggestions yet — run
  `gradient scan` first."*
- New files `commands/stats.ts`, `commands/explain.ts`; wired into `cli.ts` +
  `HELP`. No change to core pipeline modules.

### 3.3 Opt-in session-start scan

- **Config.** Add `scanOnSessionStart?: boolean` (default **false**) to `Config`.
- **Enablement.** `init` gains a toggle (prompt and/or `--session-scan` flag).
  When true, it emits a `SessionStart` hook through the existing `emit/hook.ts` +
  `validate.ts` path.
- **Non-blocking, no bespoke shell.** The v1 invariant is that emitted hooks call
  a `gradient` subcommand, never inline shell — so we cannot background with a raw
  `&`. Instead the hook command is **`gradient scan --detach`**: a mode that spawns
  the real scan as a detached child, then returns `0` immediately. Session start is
  never blocked, and the hook stays a clean subcommand invocation that
  `validate.ts` accepts.
- **Allowlist.** Extend the hook allowlist to permit event `SessionStart` backed
  by subcommand `scan`. The "no broken hooks" gate still holds (`scan` exists).
- **No incremental logic.** It runs the scan we already ship; it does not diff,
  track "seen" state, or notify. The refreshed cache is simply what the user
  reviews next time via `gradient review`. (A blocking, prints-inline variant is
  intentionally *not* specced here — non-blocking is the only mode in scope.)
- **Background failures leave a trace.** A detached scan cannot surface errors
  interactively, so it writes stdout/stderr to `.gradient/last-scan.log`. Silent
  background failure is thus still diagnosable (honoring the v1 "no silent
  failures" guardrail).

### 3.4 `scan --all` scalability (new `core/lsh.ts`)

`cluster.ts` stage 1 (exact-normalized buckets) is O(n). The cost is stage 2,
which compares every distinct bucket signature against every merged host —
O(b²) in the number of distinct signatures. On full history `b` is large, which
is why v1 added `capByRecency` as a blunt bound.

- **Minhash-LSH banding.** For each bucket's trigram set, compute a minhash
  signature; split it into bands; two buckets are compared **only** if they share
  a band. Candidate pairs are then merged with the existing `similarity()` /
  threshold, so merge *semantics* are unchanged — only which pairs get compared.
- **Isolated module.** `core/lsh.ts` (minhash + banding) is pure and unit-tested
  on its own; `cluster.ts` calls it in place of the nested `find` loop, staying
  focused.
- **Threshold mapping.** Band/row counts are chosen to approximate the current
  `simThreshold` (0.6); the standard `threshold ≈ (1/bands)^(1/rows)` relation is
  documented and pinned with fixtures in the plan.
- **`capByRecency` demotes.** It stays (still used by default/`--user`) but
  becomes a configurable **safety ceiling**; for `--all` the default ceiling is
  raised/disabled so old data is no longer silently dropped. `Config.maxPrompts`
  still applies.
- **Empty-band case is safe.** A bucket sharing no band with any other simply
  stays unmerged — identical outcome to "no host found" today.

---

## 4. Data-model deltas

```ts
// Config: opt-in session-start scan.
interface Config { /* … */ scanOnSessionStart?: boolean }

// Candidate: carry session identities so a semantic merge can union them
// exactly instead of double-counting. cluster.ts already builds this Set
// internally (Bucket.sessions), so exposing it is free.
interface Candidate {
  /* … existing fields … */
  sessions: number;        // retained (distinct-session count for this cluster)
  sessionIds: string[];    // NEW — the actual session ids, for exact merge-union
}

// detect LLM response: one suggestion may merge several clusters.
interface LlmSuggestion {
  sourceSignatures?: string[];   // was: sourceSignature?: string
  /* … */
}
```

- `Turn` and `Suggestion` shapes are **unchanged** (`Suggestion.evidence` already
  carries `{count, sessions}`, now populated from the merged aggregate).
- Caches unchanged on disk: `.gradient/suggestions.json`, `.gradient/manifest.json`,
  plus the new `.gradient/last-scan.log` for detached runs.

> **Refinements found while writing this spec (vs. the verbal design):**
> (a) `Candidate` gains `sessionIds` — needed for *exact* session-count on merge
> rather than a double-counting approximation; (b) the session-start hook uses a
> new `scan --detach` mode so it is non-blocking **and** still a pure subcommand
> call (no inline `&`). Both are small and preserve the v1 architecture.

---

## 5. Data flow

- **`scan`** → `collect → parse → filter → capByRecency(ceiling) →
  cluster (LSH-backed) → detect (widened window + merge) → validate` → write cache
  + print. Read-only on the project.
- **`scan --detach`** → same pipeline, spawned as a detached child; parent returns
  `0` immediately; output/errors go to `.gradient/last-scan.log`.
- **`stats`** / **`explain`** → read `.gradient/*.json` → print. No pipeline, no LLM.
- **`init`** → writes config; if `scanOnSessionStart`, also emits the
  `SessionStart → gradient scan --detach` hook (via `emit/hook.ts` + `validate.ts`).

---

## 6. Error handling & guardrails

- **Malformed merge** → unknown source signatures ignored; all-unknown → treat as
  un-merged; scan never crashes.
- **Missing cache** (`stats`/`explain`) → friendly "run `gradient scan` first".
- **Detached-scan failure** → captured to `.gradient/last-scan.log`; not silent.
- **No broken hooks** → `validate.ts` still rejects any hook whose event/subcommand
  is not allowlisted; `SessionStart → scan` is added explicitly.
- **LSH correctness** → banding only changes *which pairs* are compared; the
  merge threshold is unchanged, and an unbanded bucket stays unmerged (safe
  default). Equivalence is guarded by tests on small fixtures.

---

## 7. Privacy

Unchanged from v1. Only small, redacted candidate signatures ever reach the model;
the widened `detect` window adds a few more short strings, never whole transcripts.
The session-start scan runs locally and writes only to `.gradient/`.

---

## 8. Testing

- **Dedup:** mock `LLMBackend` returns a merged group over several source
  signatures → assert **one** suggestion with summed `count` and **set-unioned**
  `sessions`; assert redaction still applied; assert unknown-signature entries are
  ignored without throwing.
- **stats / explain:** fixture `suggestions.json` + `manifest.json` → assert
  ranked output and coverage math; assert friendly error with no cache.
- **session-start:** `scanOnSessionStart: true` emits a `SessionStart → scan
  --detach` hook that `validate` accepts; `false` emits none; `--detach` returns
  quickly and does not block (stubbed spawner).
- **scalability (`core/lsh.ts`):** unit tests for minhash/banding; a perf test
  showing near-linear scaling on a large synthetic candidate set; an **equivalence
  test** vs. the old O(b²) merge on small fixtures.

---

## 9. Code removed / rewritten (cleanup discipline)

- **`core/cluster.ts`** — the stage-2 nested `merged.find(m => similarity(...) >=
  threshold)` O(b²) loop is **deleted** and replaced by a call into the new
  `core/lsh.ts` banding + a bounded merge over only in-band candidate pairs.
- **`core/detect.ts`** — the singular `sourceSignature` lookup / one-to-one
  evidence mapping is **removed**; replaced by the plural, merge-aware aggregation
  (sum counts, union sessions).
- **`core/cap.ts` (`capByRecency`)** — **not** deleted. Its role narrows to a
  configurable safety ceiling; its default for `--all` is raised/disabled.
- No other module loses responsibility; `stats`/`explain`/`lsh` are additive.

---

## 10. Out of scope (YAGNI)

- The **personalized auto-responder** (phase-2 autopilot) — its own later spec.
- A full **incremental/delta mining** engine, "seen"/dismissed state, and
  background **notifications** — explicitly traded away for the opt-in
  session-start scan.
- **Embeddings** clustering — semantic dedup uses the existing LLM call instead.
- **Desktop notifications**, a **daemon/watch** mode.
- **MCP** wrapper, **local LLM** backend, **multi-assistant** install (still
  deferred from v1 §9).

---

## 11. Open questions for the implementation plan

- Final **detect window size** (~24?) and its measured token cost.
- **Minhash parameters** (`numHashes` / `bands` / `rows`) that best approximate
  `simThreshold = 0.6`, pinned against fixtures.
- **`scan --detach`** mechanics: `child_process.spawn(..., {detached:true})` +
  `unref()`, and confirming the exact `SessionStart` hook I/O contract in Claude
  Code (does hook stdout surface to the user, or only the refreshed cache?).
- Whether **`stats` coverage** also inspects `.claude/commands/` on disk, not just
  the manifest.
