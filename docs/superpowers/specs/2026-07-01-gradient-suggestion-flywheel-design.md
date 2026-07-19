# gradient — Tailored Suggestions & Feedback Flywheel: Design

**Date:** 2026-07-01
**Status:** Implemented (2026-07-18)
**Scope:** Fourth sub-project of `gradient`. Reorients suggestion quality from
"repeated text" to "user leverage", and closes the feedback loop so the system
improves from its own outcomes. Independent of Spec 2 (auto-responder); the one
touchpoint is additive (§3.6).

---

## 1. Context

v1 shipped the analysis engine; Spec 1 (continuous mining) sharpened scan
quality and added the session-start rescan; Spec 2 (auto-responder, parallel)
acts live at `Stop` time. All three share a blind spot: **suggestions are
ranked by how often text repeats, not by how much the user would gain** — and
the engine never learns from what happens to its suggestions.

Dogfooding evidence for this spec, from the first real scans:

- The detect prompt's own canonical merge example failed in production
  (`lgtm-approve` and `looks-good-approve` shipped as two overlapping
  suggestions, each telling the user to consolidate with the other).
- Suggestion ids hash the **LLM-chosen name**, so the same habit gets a new id
  every scan — the applied `pr-link` artifact's `suggestionId` already points
  at nothing. Nothing can be remembered (dismissals, coverage) without stable
  identity.
- Zero loop suggestions surfaced, despite loops being the strongest pattern in
  the v1 dataset (~150 `continue` variants). Loop classification is purely
  semantic: every `Turn` carries a timestamp, but `cluster()` discards all
  temporal structure, so the LLM guesses "loop" from wording and invents
  `cadence` freehand.
- Slash-command invocations (`<command-name>…`) are filtered out as injected
  noise — so the strongest hook evidence in the dataset (`/compact` ×143 →
  `PreCompact` checkpoint) is **structurally impossible** for the pipeline to
  see, and artifact usage after `apply` is invisible.

Four components, one theme — every suggestion should answer *"how much of your
time does this give back, and how do we know?"*:

1. **Leverage ranking + the mirror** — rank by estimated time saved, show it,
   and make bare `gradient` deliver that insight in one command.
2. **Evidence plumbing** — parse command invocations as structured events and
   compute temporal features per cluster; deterministic loop/schedule/hook
   detection falls out.
3. **Corrections → project rules** — mine repeated corrections into durable,
   reversible `.claude/rules/gradient-*.md` files without editing CLAUDE.md.
4. **The flywheel** — stable ids, persistent dismissals, artifact-usage
   tracking, and an at-most-one suggestion surfaced at session start.

---

## 2. Decisions (locked during review)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Ranking key | **Leverage (estimated time saved)** replaces raw `count` everywhere an ordering exists: the detect window, review order, surfacing. Formula in §3.1, constants pinned in the plan. |
| 2 | First-run UX | Bare `gradient` runs **the mirror**: `--user`-scope scan (if cache missing/stale) + top patterns framed as time saved + top 3 suggestions. `help` still available via `gradient help` / `-h`. |
| 3 | Identity | `Suggestion.id` = hash of the **sorted source signatures** (not the LLM-chosen name). Stable across scans and across LLM naming whims. |
| 4 | Dismissals | Persistent: review `[s]kip` records the suggestion's source signatures in `.gradient/dismissed.json`. A suggestion is suppressed when its signatures are a **subset** of previously dismissed ones — genuinely new evidence resurfaces it. Supersedes Spec 1 §10's deferral, which predates the flywheel goal. |
| 5 | Command events | `<command-name>` turns are **parsed into structured `CommandEvent`s** during parse, replacing the filter-out. Powers hook evidence (§3.2) and usage tracking (§3.4). |
| 6 | Temporal evidence | A new pure module computes per-cluster run-length/cadence features locally. Loops/schedules/`PreCompact` hooks are **classified deterministically first**; the LLM refines wording with the features visible. Degraded (LLM-less) mode can now emit loops and hooks, not just commands. |
| 7 | Project rules | Reuse the existing `rule` payload. Apply project-scoped corrections as standalone `.claude/rules/gradient-<name>.md` files with provenance markers; track them in the manifest and remove them through the existing `remove` path. Never edit CLAUDE.md. |
| 8 | Surfacing | New `gradient session-start` subcommand replaces `scan --detach` as the installed SessionStart hook: it prints **at most one** new suggestion from the existing cache (<100ms, no LLM), then spawns the detached rescan. `scan --detach` itself remains a valid public mode. |
| 9 | Merge enforcement | The lgtm/looks-good failure is fixed **in code, not prompt**: after detect parses, a deterministic post-pass merges suggestions whose payloads/names are near-duplicates (same trigram `similarity()` ≥ threshold on normalized name+body). Prompt keeps asking; code stops trusting. |
| 10 | Pruning | Advisory, not automatic: `stats` reports applied artifacts with zero observed uses and prints the exact `gradient remove <name>` line. No new payload type, no auto-deletion. |

---

## 3. Components

### 3.1 Leverage ranking + the mirror

**Leverage estimate** (local, no LLM), per suggestion, from evidence the
pipeline already has:

```
typingSeconds   = promptChars / TYPING_CPS          // ~3.3 chars/s ≈ 40 wpm
roundTripSecs   = ROUND_TRIP_S                      // fixed context-switch cost, ~15s
perOccurrence   = typingSeconds + roundTripSecs     // commands
                | ROUND_TRIP_S                      // loops (babysitting check-in)
                | CORRECTION_S                      // rule (wasted round trip, ~60s)
estMinutesSaved = count × perOccurrence / 60
perMonth        = estMinutesSaved × 30 / max(observedSpanDays, 7)
```

Constants are deliberately conservative and pinned/tuned in the plan; the
point is an *explainable* ordering ("≈ 40m/month"), not accounting precision.

- `detect`'s window ordering and the degraded path both switch from
  `count`-descending to leverage-descending (the count sort is removed, §9).
- `review` header becomes:
  `(1/6) ship · command · ≈ 38m/month (11× across 7 sessions) · high`,
  followed by the title **and the first redacted example**. Key map gains
  `[e]xplain` (prints the full `explain` output inline, then re-prompts).
- `review`'s inline explanation prints the leverage estimate alongside the
  observed count and session total. `explain` also prints the estimate and any
  temporal evidence retained in the cache, so the ranking is auditable.
- **Bare `gradient`** runs the mirror: if no cache (or older than 24h), run the
  `--user`-scope scan first, then print the top patterns with per-month time
  framing and the top 3 suggestions. One command → visible value; this is the
  `npx gradient` first-contact experience. Two mechanics keep it honest:
  leverage is computed locally from observed evidence, while any stale/missing
  cache is refreshed before results are printed; and **non-TTY invocations keep
  the current help behavior**, so scripts and CI never trigger a scan by
  accident.

### 3.2 Evidence plumbing: command events + temporal features

**Command events.** `parse.ts` gains a second output: user turns whose text
begins with `<command-name>` become
`CommandEvent { ts, sessionId, project, command }` (e.g. `command: "/compact"`)
instead of being dropped by `filter.ts` (that pattern is deleted from
`INJECTED_PATTERNS` — extraction supersedes exclusion; the other injected
patterns are unchanged). Events never enter clustering; they feed §3.2
hook detection and §3.4 usage tracking.

**Temporal features.** `cluster.ts` keeps per-bucket occurrence metadata
(`{ts, sessionId}[]`, unioned on merge). A new pure module `core/temporal.ts`
computes, per candidate:

```ts
interface TemporalFeatures {
  maxRunLength: number;      // longest streak of consecutive user prompts
                             // in one session all belonging to this cluster
  runSessions: number;       // sessions containing a run of length ≥ 2
  medianGapMinutes: number;  // between successive occurrences
  distinctDays: number;
  spanDays: number;
}
```

**Deterministic classification, before the LLM** (thresholds pinned in plan):

- `maxRunLength ≥ 3` in ≥ 2 sessions → `kind: "loop"`; no cadence → emits
  `/loop "…"` as today, but the rationale cites measured evidence
  ("typed a median of 4× in a row across 12 sessions").
- Near-daily regularity (`distinctDays ≥ 5`, observed-day coverage ≥ 0.8) →
  loop **with derived cadence** (daily cron at the median hour) → `/schedule`.
  Cadence is generated by code, so it is valid by construction — the emit-time
  charset scrub stops being the only defense.
- `/compact` events ≥ 10 across ≥ 3 sessions → a `PreCompact` hook suggestion
  built without any LLM (same payload the LLM path produces today).

The LLM still sees these candidates — with `temporal` serialized into the
detect prompt — and may improve names/wording, but it can no longer *miss*
a loop the data supports, and the degraded path now emits loops and hooks.

### 3.3 Corrections → project rules

A correction the user repeats across sessions ("no, use pnpm", "stop adding
comments") is a standing instruction the assistant keeps not having. That
belongs in a project rule, not in a slash command.

- **Detection**: a lexical pre-classifier tags correction-shaped prompts
  (normalized text matching a pinned prefix lexicon: `no,`/`don't`/`stop`/
  `actually`/`i said`/`i told you`/`you didn't`/`wrong`/`use X not Y`…;
  precision measured against the dogfood corpus in the plan). Correction
  clusters bypass the command path and reach detect as `kind: "correction"`.
- **Scope**: correction mining runs only for project scans. Cross-project scans
  deliberately skip it so a preference observed in one repository cannot
  silently become policy in another.
- **Synthesis**: the detect backend routes the cluster to the existing rule
  payload `{ type: "rule", target: "project", ruleName, text }` (for example,
  `Use pnpm, never npm.`), then the rule text is reconstructed locally from the
  redacted evidence rather than trusted from model output. When a backend is
  unavailable, correction candidates are omitted rather than guessed.
- **Apply** (`emit/rule.ts`): write one standalone
  `.claude/rules/gradient-<name>.md` file with provenance markers. The manifest
  links that artifact to the suggestion id, so `remove` deletes exactly that
  generated file. Existing CLAUDE.md content is never read or modified.
- `review`, `list`, `remove`, and `stats` use the already-supported `rule`
  artifact type; no new payload or artifact type is introduced.

### 3.4 The flywheel: identity, dismissals, usage, surfacing

- **Stable ids** (Decision 3): `idFor(sortedSourceSignatures.join("\n"))` for
  both LLM and degraded paths. Coverage in `stats` and the manifest link stop
  breaking on rename.
- **Dismissals** (Decision 4): `.gradient/dismissed.json` stores
  `{ id, signatures: string[], name, dismissedAt }` per skip. State is bounded,
  validated, private (`0600`), and read through symlink-safe helpers. Presentation-time
  filtering only (review, mirror, surfacing) — the cache stays complete, so
  `explain` still works and un-dismissing is editing one file.
- **Usage tracking**: `stats` matches live `CommandEvent`s against manifest
  artifact names, counted since each artifact's `createdAt`, and combines that
  with the private append-only adoption ledger used by recall. No derived
  `usage.json` state is written. `stats` reports **realized minutes saved** and
  lists artifacts with no observed use or retype interception after 30 days,
  including the exact `gradient remove <name>` line (Decision 10). Approval is
  no longer the metric; observed use is.
- **Surfacing** (`commands/sessionStart.ts`, Decision 8): the SessionStart
  hook becomes `gradient session-start`, which (a) reads cache + dismissed +
  manifest, picks the highest-leverage suggestion that is new (not applied,
  not dismissed, above a minimum-leverage floor) and prints **one line**
  (SessionStart hook stdout lands in the session context, so Claude itself can
  relay it naturally):

  ```
  gradient: you've typed variants of "write the plan, then implement" 11× (≈ 38m/month) — run `gradient review` to make it /plan-impl
  ```

  then (b) spawns the detached rescan exactly as `scan --detach` does today
  (print first, spawn after — the print must never wait on the scan). Any
  cache/state/output/spawn error → exit 0 without failing the session. The
  detached scan owns its normal `.gradient/last-scan.log`; read failures stay
  silent so no malformed local state enters session context. `init
  --session-scan` now installs `session-start`
  (allowlisted in `validate.ts`); re-running `init` migrates an existing
  `scan --detach` hook entry.

The loop this closes: **detached scan mines → next session surfaces ≤ 1
suggestion → approve writes an artifact / skip suppresses it forever → later
scans observe whether the artifact is actually used → stats reinforces or
recommends pruning.** The system's own outputs become its inputs; no daemon,
no notifications, no new trigger surface beyond the hook Spec 1 shipped.

### 3.5 Merge enforcement (Decision 9)

After detect parses the LLM response (and after evidence aggregation), a
deterministic pass merges near-duplicate suggestions: normalize
`name + payload body/instruction/rule`, compare with the existing trigram
`similarity()`, merge above a pinned threshold (evidence summed, sessions
unioned, id recomputed from the union of source signatures). The prompt's
merge instruction stays — this pass is the guarantee, not the hope.

### 3.6 Spec 2 seam (additive only)

Spec 2's playbook (§3.3 there) renders "How I nudge" from loop-kind clusters
"the pipeline already computed". This spec makes that data real: temporal
features give the playbook measured run-lengths and phrasings with counts, and
the §3.6-there review hint can cite them ("median 4× in a row"). No Spec 2
code changes; the enrichment flows through data it already reads.

---

## 4. Data-model deltas

```ts
// parse.ts — second output alongside Turn[]:
interface CommandEvent { ts: string; sessionId: string; project: string; command: string }

// Candidate gains local-only evidence (never sent to the LLM raw;
// TemporalFeatures is serialized into the detect prompt instead):
interface Candidate {
  /* … existing … */
  occurrences: { ts: string; sessionId: string }[];  // NEW (from Bucket)
  temporal?: TemporalFeatures;                        // NEW (core/temporal.ts)
}

// The existing rule payload carries correction-derived project rules:
type SuggestionPayload = /* command | loop | hook */ |
  { type: "rule"; target: "project" | "user"; ruleName: string; text: string };
type ArtifactType = "command" | "loop" | "hook" | "skill" | "rule";

// Suggestion evidence gains the ranking basis (display + ordering):
interface Suggestion {
  /* … */
  sourceSignatures?: string[];
  evidence: {
    count: number;
    sessions: number;
    estMinutesSavedPerMonth?: number;
    temporal?: TemporalFeatures;
  };
}

// New project-local state (all human-readable, all optional at read time):
// .gradient/dismissed.json   { id: string; signatures: string[]; name: string; dismissedAt: string }[]
```

`sourceSignatures`, leverage, and temporal cache fields remain optional so
pre-flywheel caches can be read safely. Stable-id adoption does not rewrite old
manifest entries; the migration procedure is documented below.

---

## 5. Data flow

```
scan
  └─ collect → parse ──→ Turn[] ─ filter → cap → cluster(+occurrences)
               └──────→ CommandEvent[] ─┐
     temporal.ts: features per candidate │
     deterministic pre-classify (loops/schedules/PreCompact ←┘)
     detect (leverage-ordered window, features in prompt)
     post-merge pass (§3.5) → validate
     → suggestions.json (+sourceSignatures, leverage, temporal evidence)
mirror (bare `gradient`)
  └─ cache fresh? print : run --user scan first → time-saved summary + top 3
review
  └─ leverage order, dismissed filtered; [a]pply [s]kip→dismissed.json [e]xplain [q]uit
session-start (SessionStart hook)
  └─ print ≤1 new suggestion from cache → spawn detached rescan → exit 0
apply (rule)
  └─ standalone .claude/rules/gradient-<name>.md + manifest entry → removable
stats
  └─ live CommandEvents + private adoption ledger → realized value / prune advice
```

---

## 6. Error handling & guardrails

- **Rule safety**: correction-derived rules are project-only, written as
  standalone generated files with provenance, and require explicit review and
  approval before apply. CLAUDE.md is never edited.
- **Dismissal state**: malformed, oversized, absent, or symlinked state is
  treated as empty without output. New writes are validated, bounded, atomic,
  private, and symlink-safe. Worst case is a re-shown suggestion.
- **session-start**: hard fail-open — any error prints nothing and exits 0;
  stdout is budgeted to one line so a bug can't flood the session context.
- **Temporal classification**: purely additive pre-classification; a cluster
  that trips no rule flows to the LLM exactly as today.
- **Post-merge pass**: only merges (never drops) suggestions; a merge that
  can't recompute evidence keeps the higher-leverage member unchanged.
- **Privacy unchanged**: `CommandEvent`s and `TemporalFeatures` are computed
  and kept locally; the detect prompt gains only the small serialized feature
  struct per candidate. Correction snippets are redacted like all examples.

---

## 7. Testing

House style: pure units, injected deps, no network.

- **Leverage**: formula fixtures per payload type; per-month normalization
  clamps; ordering replaces count everywhere (window, review, degraded path).
- **parse/filter**: `<command-name>` turns become events (not prompts, not
  dropped); remaining injected patterns still filtered.
- **temporal.ts**: run-length across interleaved clusters; gaps/day features;
  boundary cases (single occurrence, one session).
- **Deterministic classifiers**: loop/schedule/hook rules at and below
  thresholds; derived cron validity; degraded mode now emits loops + hooks.
- **rule emit**: standalone generated rule is written/removed by id; provenance
  and manifest round-trip are preserved; CLAUDE.md is never touched.
- **Flywheel**: stable id invariance under renaming; subset dismissal rule
  (dismissed / resurfaced-on-new-evidence); usage counting since `createdAt`;
  `stats` realized-value + prune advisory output.
- **session-start**: prints ≤1, respects dismissed/applied/floor, fail-open
  paths exit 0 silently, spawn happens after print (stubbed spawner);
  `init` migration replaces the old `scan --detach` hook entry exactly once.
- **Post-merge pass**: the lgtm/looks-good dogfood fixture merges to one
  suggestion with summed evidence and recomputed id.

---

## 8. Code removed / rewritten (cleanup discipline)

- **`detect.ts`** — the `count`-descending sort is **removed** (leverage
  ordering replaces it); `degradeToCommands` is **replaced** by a degrade path
  that also emits deterministically-classified loops/hooks; id derivation from
  LLM-chosen names is **removed** in favor of signature-set hashing.
- **`filter.ts`** — valid `<command-name>` turns are extracted into events at
  parse time. Defensive command-message/args fallbacks remain so malformed or
  partial injected envelopes cannot enter clustering.
- **`cluster.ts`** — `Bucket.examples`-style occurrence trimming extended to
  carry `{ts, sessionId}`; no behavior removed.
- **`cli.ts`** — bare-invocation behavior changes from help to mirror
  (help remains on `help`/`-h`/`--help`); HELP text updated for
  `session-start` and the new review key.
- **`init.ts` / `validate.ts`** — SessionStart hook target changes to
  `session-start`; the old `scan` allowlist entry **stays** (it is still a
  valid subcommand and the detached child), but init no longer installs it
  directly and migrates old entries.
- **Docs**: README quickstart gains the bare-`gradient` mirror as the first
  command; Spec 1 §10's "no dismissed state" line is superseded by this spec
  (annotate, don't rewrite history).

---

## 9. Out of scope (YAGNI)

- **Additional sequence-mining expansion** — the existing bounded sequence
  candidates remain in the pipeline, but learning arbitrary workflow graphs
  or cross-project chains is deferred.
- **Self-tuning ranker weights** (learning leverage constants from approvals)
  — dismiss/boost via the flywheel is enough until evidence says otherwise.
- **Cross-project correction mining** — corrections are project-scope only;
  user-scope scans skip them rather than transferring repository-specific
  preferences across projects.
- **Un-dismiss UI** — `dismissed.json` is documented and human-editable.
- **Auto-pruning** — advisory only (Decision 10).
- Embeddings, daemon/watch, desktop notifications, MCP, and a local LLM remain
  deferred. Multi-assistant collection is implemented independently.
- Anything at `Stop` time — that is Spec 2's surface entirely.

---

## 10. Resolved implementation choices and migration

- Leverage uses `TYPING_CPS = 3.3`, `ROUND_TRIP_S = 15`, and
  `CORRECTION_S = 60`; session-start surfaces only estimates of at least five
  minutes per month.
- Correction candidates require at least three occurrences across two sessions
  and a pinned, anchored opener lexicon. Common dismissive phrases such as
  “never mind” and “no worries” are excluded.
- Dismissal matching uses the signature-subset rule, with id fallback for old
  cache entries that do not carry signatures. New evidence can resurface a
  previously dismissed pattern.
- Duplicate merging requires distinctive content similarity, or strong name
  similarity plus supporting body text. Payload subtype guardrails prevent
  semantically different hooks, rules, or schedules from merging.
- Schedule cadence is derived in code from the median observed UTC hour. Model
  output cannot override deterministic temporal classification.
- The SessionStart path prints at most one cached suggestion before launching a
  detached rescan. Bare interactive invocation prints at most three; non-TTY
  invocation continues to show help.
- **Stable-id migration:** ids now derive from source signatures, so a cache or
  manifest created before this release may reference the same suggestion under
  its old name-derived id. After upgrading, run `gradient scan`, then
  `gradient review`; re-apply an affected suggestion and remove its old
  artifact if both versions are listed. Existing files are never deleted or
  rewritten automatically.

Main moved substantially while implementation was in flight. This document is
reconciled to the landed design as of 2026-07-18; the plan's revision log maps
the task-level changes.
