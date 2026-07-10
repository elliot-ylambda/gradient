# gradient — Review Disambiguation & Attention Hooks — Design

**Date:** 2026-07-09
**Status:** Implemented (2026-07-10)
**Scope:** Spec 9. Two independently shippable components that close the
funnel where Tier 2 gaps remain: (1) **flagged-suggestion disambiguation**
in `review` — the judge's identified ambiguity becomes one question the
user answers instead of a dead end; (2) **attention hooks** — a mined,
suggest-only `Notification` desktop-ping artifact backed by a new
`gradient notify` subcommand. Builds on Spec 4 Phase A (detect churn) and
reuses Spec 6's generalized hook payload; Component 2's evidence heuristic
reuses Phase C2's assistant-turn parse.

---

## 1. Tier coverage map (why this spec is the Tier 2 delta)

| Tier 2 idea | Owner |
|---|---|
| Impact tracking / adoption ROI | Spec 4 Phase B2 (+ suggestion-flywheel draft: stable ids, dismissals) |
| Behavior insights & coaching | Spec 4 Phase D |
| Continuity (PreCompact/SessionStart pack) | Spec 4 Phase D (continuity pack) |
| **Flagged suggestions stall unresolved** | **This spec, Component 1** |
| **Nobody notices Claude waiting** | **This spec, Component 2** |

Evidence for Component 1: two of the first three real suggestions
(`lgtm-approve`, `looks-good-approve`) shipped `confidence: "flagged"` with
the ambiguity *already articulated in the rationale* ("acknowledge vs.
actually merge") — and then had nowhere to go. Spec 4 A2 merges the twins at
detect time but does not resolve the intent question. Flagged patterns are
frequent-but-personal — exactly the ones worth converting.

Evidence for Component 2: waiting-on-you gaps are visible in transcripts as
long deltas between an assistant question and the human answer; the
community's most-shared hand-written hook is a desktop ping on
`Notification`. Specs 1–2 deferred "desktop notifications" *as a gradient
feature* (scan results, autopilot stand-down); this is different — a mined,
user-approved **artifact**, same as any other suggestion.

## 2. Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Where disambiguation happens | **At detect time, resolved at review time.** The judge emits the clarifying question *and a complete replacement body per option* while it already has the evidence in context. `review` then just presents a choice — it stays LLM-free, offline, and deterministic. No new LLM call from `review`. |
| 2 | Schema | Flagged suggestions may carry `clarify?: { question: string; options: [{ label: string; body: string }] }` (2–3 options). A `sanitizeClarify` gate in `detect.ts` (the layer that maps the LLM response — not the autopilot judge in `judge.ts`) accepts a fully valid shape or drops the field: the suggestion survives as plain flagged, never rejected and never half-validated. Suggestions without `clarify` review exactly as today. |
| 3 | Resolution semantics | Choosing an option **replaces the payload body and promotes `confidence` to `"high"`** (a human resolved the ambiguity), then the normal approve path runs. Declining to choose keeps the suggestion flagged and unapplied. The suggestion `id` is unchanged — identity comes from the mined pattern, not the chosen wording. |
| 4 | Notification artifact | A **suggest-only hook**: Spec 6's generalized hook payload with `event: "Notification"`, `matcher: "permission_prompt\|idle_prompt"`, `subcommand: "notify"`. Emitted only when evidence crosses the floor (Decision 6). Never auto-installed — review → apply → manifest → removable, like everything. |
| 5 | `gradient notify` | New subcommand: reads the hook's stdin JSON, fires a local OS notification — macOS `osascript`, Linux `notify-send` — with a short static message ("Claude Code is waiting on you"). **Always exits 0**; missing binaries, parse failures, unknown platforms all no-op silently (fail-open, `respond`'s contract). Notification content never includes transcript text — no redaction surface at all. |
| 6 | Evidence heuristic | An **attention gap** = assistant turn whose tail is a question (Phase C2's detector) followed by a human answer ≥ 5 minutes later. Floor: gaps in **≥ 5 sessions** → one `Notification`-hook suggestion per scan scope, with the gap count and median wait as evidence lines. Constants pinned by fixtures. |
| 7 | Deps | Zero new runtime dependencies; notifications use OS binaries via the existing spawn seam. |

## 3. Component 1 — flagged-suggestion disambiguation

### Detect / judge

- `detect.ts` briefing addition: *when you mark a suggestion `flagged`
  because the user's intent is ambiguous, include `clarify` — one question,
  2–3 options, each with a full replacement body reflecting that reading.*
  The `lgtm` case becomes: "When you say 'lgtm', should gradient
  acknowledge, or approve-and-merge the PR?" with two complete bodies.
- `detect.ts`: `sanitizeClarify` per Decision 2; a malformed `clarify`
  drops the field silently (unit-tested) and the suggestion survives as
  plain flagged — never a crash, never a half-validated object.

### Review

- On a flagged suggestion with `clarify`, `review` renders the question and
  options (existing readline UX), then per Decision 3 swaps the body,
  promotes confidence, and continues into the normal approve/skip prompt.
- Resolution is recorded, not erased: the suggestion keeps its `clarify`
  field and gains `clarify.chosen: <label>`; `suggestions.json` is
  rewritten with the resolved body. `explain` renders the original
  question, the options, and which one was chosen — full provenance for a
  decision that changed what the artifact does.

## 4. Component 2 — attention hooks

- `core/attention.ts`: computes attention gaps (Decision 6) with its own
  small line scanner over the collected transcripts (the C2 lift-forward:
  question-tail detection scoped to this module; it merges with Phase C2's
  assistant-turn parse when Phase C lands).
- Suggestion rendering in `review`: "You left Claude waiting ≥ 5 minutes in
  12 sessions (median 14 min). Install a desktop ping when it needs you?"
- `commands/notify.ts`: per Decision 5. The hook payload's `subcommand`
  form means `settings.json` carries `gradient notify` — the same
  trust-shape as `gradient respond` / `gradient checkpoint`.
- Once `notify` exists, autopilot stand-down and scan completion **may**
  reuse it later — recorded here as a pointer, explicitly not built.

## 5. Out of scope (YAGNI)

- **Review-time twin merging** — Spec 4 A2 owns same-intent merging at
  detect time; a review-side safety net is redundant machinery.
- **Free-text clarification answers** — options only; a custom body is what
  `explain` + hand-editing the artifact are for.
- **Windows toasts** — macOS/Linux first; Windows no-ops (fail-open).
- **Re-clarifying applied artifacts** — resolution happens once, pre-apply.
- **Migrating autopilot to native `prompt`/`agent` hook types** — the
  spawn-based judge keeps its recursion guard and model choice; revisit
  only if Claude Code's native types grow equivalent controls.

## 6. Sequencing & dead code

- Lands **after Spec 4 Phase A merges** — A5 rewrites the detect prompt
  this spec extends; sequencing avoids a rebase war over `detect.ts`.
- Component 2 wants C2's assistant-turn parse; if C has not landed, the
  plan lifts that one parse mode forward (it is Phase C's smallest piece)
  rather than blocking.
- Dead code: none removed. The `HELP` text and README gain `notify` and the
  clarify flow in the same commits that ship them; no stale docs.

## 7. Testing

- Schema: valid clarify accepted; malformed dropped-with-log; plain flagged
  suggestions untouched.
- Review flow: choose → body swapped, confidence `"high"`, manifest entry
  identical shape; decline → still flagged, nothing written;
  `suggestions.json` round-trip preserves resolution.
- `notify`: malformed stdin, missing binary, unknown platform → exit 0,
  no output; macOS/Linux dispatch (spawn seam mocked).
- Attention gaps: fixture sessions with known gaps; floor boundaries;
  question-tail detection reuse; zero-gap history → no suggestion.

## 8. Open questions for the implementation plan

- Whether `clarify` options cap at 2 or 3 (fixture-driven — do real
  ambiguities ever need a third reading?).
- The exact `Notification` hook matcher names (`permission_prompt`,
  `idle_prompt`) verified against current Claude Code docs at build time,
  same caveat as Spec 4's B1 open question.
- Whether the attention-gap floor should also require a minimum *median*
  wait, not just session count, to avoid pinging fast responders.
