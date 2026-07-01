# gradient — Tailored Suggestions & Feedback Flywheel: Design

**Date:** 2026-07-01
**Status:** Draft (reviewed in conversation; pending approval; implementation plan pending)
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
3. **Corrections → CLAUDE.md rules** — mine repeated corrections into durable,
   reversible CLAUDE.md rules: the most tailored artifact Claude Code has.
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
| 7 | CLAUDE.md rules | Fourth payload type `claude-md`. Applied only inside a gradient-managed marker block in the **project** CLAUDE.md; one id-tagged line per rule; removable via the existing manifest/`remove` path. |
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
                | CORRECTION_S                      // claude-md (wasted round trip, ~60s)
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
- `explain` additionally prints the temporal evidence (§3.2) and the leverage
  arithmetic, so "≈ 38m/month" is always auditable.
- **Bare `gradient`** runs the mirror: if no cache (or older than 24h), run the
  `--user`-scope scan first, then print the top patterns with per-month time
  framing and the top 3 suggestions. One command → visible value; this is the
  `npx gradient` first-contact experience. Two mechanics keep it honest:
  the mirror's headline **needs no LLM** (clustering + leverage are local), so
  the time-saved summary prints as soon as clustering finishes and the
  LLM-refined suggestions stream in after; and **non-TTY invocations keep the
  current help behavior**, so scripts and CI never trigger a scan by accident.

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
- Near-daily regularity (`distinctDays ≥ 5`, fires most observed days) →
  loop **with derived cadence** (daily cron at the median hour) → `/schedule`.
  Cadence is generated by code, so it is valid by construction — the emit-time
  charset scrub stops being the only defense.
- `/compact` events ≥ 10 across ≥ 3 sessions → a `PreCompact` hook suggestion
  built without any LLM (same payload the LLM path produces today).

The LLM still sees these candidates — with `temporal` serialized into the
detect prompt — and may improve names/wording, but it can no longer *miss*
a loop the data supports, and the degraded path now emits loops and hooks.

### 3.3 Corrections → CLAUDE.md rules

A correction the user repeats across sessions ("no, use pnpm", "stop adding
comments") is a standing instruction Claude keeps not having. That belongs in
CLAUDE.md, not in a slash command.

- **Detection**: a lexical pre-classifier tags correction-shaped prompts
  (normalized text matching a pinned prefix lexicon: `no,`/`don't`/`stop`/
  `actually`/`i said`/`i told you`/`you didn't`/`wrong`/`use X not Y`…;
  precision measured against the dogfood corpus in the plan). Correction
  clusters bypass the command path and reach detect as `kind: "correction"`.
- **Synthesis**: the detect LLM turns the cluster into a durable rule —
  payload `{ type: "claude-md", rule: string }` (e.g. `Use pnpm, never npm.`).
  The detect system prompt's payload schema gains this fourth alternative, and
  redaction applies as everywhere else.
- **Apply** (`emit/claudeMd.ts`): append one line inside a managed block in
  the project `CLAUDE.md` (created if missing):

  ```markdown
  <!-- gradient:rules:start -->
  - Use pnpm, never npm. <!-- gradient:59d24553ab -->
  <!-- gradient:rules:end -->
  ```

  Each rule line carries its suggestion id, so `remove` deletes exactly that
  line via the manifest. gradient **never** touches content outside the
  markers; a malformed block (start without end) → refuse with a clear error,
  same discipline as the corrupt-settings guard from Spec 1.
- `ArtifactType` gains `"claude-md"`; review/list/remove/stats handle the new
  type (§4, §9).

### 3.4 The flywheel: identity, dismissals, usage, surfacing

- **Stable ids** (Decision 3): `idFor(sortedSourceSignatures.join("\n"))` for
  both LLM and degraded paths. Coverage in `stats` and the manifest link stop
  breaking on rename.
- **Dismissals** (Decision 4): `.gradient/dismissed.json` stores
  `{ signatures: string[], name, dismissedAt }` per skip. Presentation-time
  filtering only (review, mirror, surfacing) — the cache stays complete, so
  `explain` still works and un-dismissing is editing one file.
- **Usage tracking**: scan matches `CommandEvent`s against manifest artifact
  names and writes `.gradient/usage.json`
  (`{ [artifactName]: { uses, lastUsed } }`, counted since each artifact's
  `createdAt`). `stats` gains a **realized value** section — "your gradient
  commands fired 31× this week" — and lists applied-but-unused artifacts with
  the exact `gradient remove <name>` line (Decision 10). Approval is no longer
  the metric; observed use is.
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
  error → exit 0, silent, logged to `.gradient/last-scan.log`; session start
  is never blocked. `init --session-scan` now installs `session-start`
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

// Payload union gains the fourth type:
type SuggestionPayload = /* command | loop | hook */ | { type: "claude-md"; rule: string };
type ArtifactType = "command" | "loop" | "hook" | "claude-md";

// Suggestion evidence gains the ranking basis (display + ordering):
interface Suggestion { /* … */ evidence: { count: number; sessions: number; estMinutesSavedPerMonth: number } }

// New project-local state (all human-readable, all optional at read time):
// .gradient/dismissed.json   { signatures: string[]; name: string; dismissedAt: string }[]
// .gradient/usage.json       { [artifactName: string]: { uses: number; lastUsed: string } }
```

`Turn`, config, manifest schema: unchanged (manifest entries simply may carry
the new `type`). Suggestion cache format grows one evidence field.

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
     → suggestions.json (+estMinutesSaved), usage.json
mirror (bare `gradient`)
  └─ cache fresh? print : run --user scan first → time-saved summary + top 3
review
  └─ leverage order, dismissed filtered; [a]pply [s]kip→dismissed.json [e]xplain [q]uit
session-start (SessionStart hook)
  └─ print ≤1 new suggestion from cache → spawn detached rescan → exit 0
apply (claude-md)
  └─ managed block in ./CLAUDE.md, id-tagged line, manifest entry → removable
```

---

## 6. Error handling & guardrails

- **CLAUDE.md safety**: writes only between the markers; missing/odd markers →
  refuse with instructions, never guess. Whole-file write only after a
  successful parse of the existing file (Spec 1 `settings.ts` precedent).
- **Dismissed/usage files**: corrupt → treated as empty with a printed
  warning; never rewritten unless the new content serializes cleanly. Worst
  case is a re-shown suggestion — annoying, not destructive.
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
- **claude-md emit**: block created/appended/removed by id; refuses malformed
  markers; never touches text outside; manifest round-trip via `remove`.
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
- **`filter.ts`** — the `^<command-(name|message|args)` pattern is **deleted**;
  parse-level extraction supersedes it. Its test moves to the parse suite.
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

- **Sequence mining** (multi-prompt workflow chains → one command/skill) —
  needs this spec's plumbing anyway; revisit once correction-mining signal
  quality is proven. (Consistent with Spec 2 §10.)
- **Self-tuning ranker weights** (learning leverage constants from approvals)
  — dismiss/boost via the flywheel is enough until evidence says otherwise.
- **User-scope (`~/.claude/CLAUDE.md`) rules** — project-scope only in v1;
  cross-project corrections still surface per-project.
- **Un-dismiss UI** — `dismissed.json` is documented and human-editable.
- **Auto-pruning** — advisory only (Decision 10).
- Embeddings, daemon/watch, desktop notifications, MCP, local LLM,
  multi-assistant: all still deferred (v1 §9, Spec 1 §10).
- Anything at `Stop` time — that is Spec 2's surface entirely.

---

## 10. Open questions for the implementation plan

- Leverage constants (`TYPING_CPS`, `ROUND_TRIP_S`, `CORRECTION_S`) and the
  minimum-leverage floor for surfacing — sanity-check against the dogfood
  corpus so the mirror's numbers feel honest, not inflated.
- Correction lexicon: measure precision/recall on real history; decide whether
  a `flagged` confidence is forced on low-precision patterns.
- Subset dismissal rule: validate against real merge drift (does the LLM
  re-composing clusters resurface dismissed suggestions too often?).
- `session-start` print → context injection: confirm SessionStart stdout
  surfacing behavior (inherits Spec 1 §11's open question) and the exact
  one-line format.
- Whether `usage.json` should also count invocations of commands the user
  created manually (mirrors Spec 1's open question about `stats` coverage
  reading `.claude/commands/` from disk).
- Post-merge similarity threshold for §3.5 (start at the cluster
  `simThreshold` 0.6? measure on the lgtm fixture family).
