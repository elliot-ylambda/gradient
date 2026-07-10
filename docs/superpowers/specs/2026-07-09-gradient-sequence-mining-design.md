# gradient — Sequence Mining: Workflows From What Follows What — Design

**Date:** 2026-07-09
**Status:** Draft (proposed; awaiting user review)
**Scope:** Spec 8. Mines *ordered* structure — which prompt follows which
within a session — into two sinks: multi-step **skill suggestions** and a
**Workflows subsection** of the global `gradient.md` mined region. Builds on
Spec 4 Phase A (classifier) and the shipped Spec 3 playbook machinery;
independent of Phases B–E.

---

## 1. Tier coverage map (why this spec is the Tier 1 delta)

Of the "widen the mining surface" tier, two of three ideas are already owned
elsewhere; this spec deliberately contains only the third:

| Tier 1 idea | Owner |
|---|---|
| Corrections / restatements → rules | Spec 4 Phase C2 (answer mining) + Spec 7 (instruction audit) |
| Friction: error pastes, failure loops, rituals | Spec 4 Phase C1 + Spec 6 (tool-event mining) |
| Permission mining | Excluded — Spec 4 Decision 8 (built-in `/fewer-permission-prompts` owns it) |
| **Sequences: what follows what** | **This spec** |

Spec 2 §10 deferred sequence mining "revisit with evidence". The evidence
arrived: dogfooding surfaced hand-typed chains — "review the spec **then**
write the plan", "push and open a PR **and** review it", "merge main into
this PR **and then** review it" (typed 10+ times, Spec 4 §1) — and the
`gradient.md` Workflows section (Spec 3 §3) is today hand-authored only,
with nothing feeding it.

## 2. Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Input | **Consecutive `"human"`-class prompts within a session** (Phase A classifier), in transcript order — `parse.ts` already yields session-ordered turns. No gap tolerance in v1: A→B counts only when B is the next human turn after A. |
| 2 | Node identity | A prompt's node is its **cluster signature** (existing `normalize` + `similarity`/LSH assignment). Prompts matching the **nudge lexicon are never nodes and are transparent**: adjacency bridges over them ("review it" → "continue" → "now push" is a real review→push chain — a nudge continues the current step, it doesn't start a new one). Nudges as automation are autopilot's territory (Spec 2). |
| 3 | Support floor | A bigram (A→B) becomes a finding at **≥ 3 occurrences across ≥ 2 sessions** — the same floor as C1 / Spec 6 / Spec 7. Overlapping bigrams above the floor (A→B, B→C) merge into one chain (A→B→C) when the joint occurrences share sessions. |
| 4 | Artifacts — no new payload type | Two sinks, neither adds to `SuggestionPayload`: (a) **skill suggestions** — chains enter the detect window as candidates (kind `"sequence"`) and come out as ordinary `command`(→skill) payloads whose body is the multi-step workflow; (b) **playbook Workflows** — top chains render deterministically (no LLM) into a `## Workflows (mined)` subsection of the global `gradient.md` mined region, refreshed by `scan` like the nudge section. The committed project `gradient.md` is never written (Spec 3 Decision 2 stands; its `apply` payload remains deferred). |
| 5 | Caps | Tracked bigrams capped (~2,000, most-recent-first) and sequence candidates capped at **⌈detect window / 4⌉** so prompt candidates keep priority — both caps logged when hit (Spec 6 Decision 5's no-silent-caps stance). |
| 6 | Privacy & deps | Zero new runtime dependencies. Only cluster signatures (short, already redaction-scrubbed) reach the LLM; playbook lines are rendered locally from signatures without any model call. |

## 3. Module: `core/sequence.ts`

```ts
export interface ChainFinding {
  steps: string[];        // ordered cluster signatures, length ≥ 2
  count: number;          // occurrences of the full chain
  sessions: number;       // distinct sessions containing it
  examples: string[][];   // ≤ 3 redacted example prompt-tuples
}

export function mineSequences(
  turns: Turn[],               // session-ordered, "human" class only
  assign: (text: string) => string | null,  // cluster-signature lookup; null = unclustered
  isNudge: (text: string) => boolean,       // nudge-lexicon check (Decision 2)
): ChainFinding[];
```

- Single pass per session: map each turn to its node (Decision 2), emit
  adjacent pairs, tally `(count, sessions)` per pair, merge overlapping
  pairs (Decision 3), sort by `count`, apply caps (Decision 5).
- Nudge turns are skipped transparently (Decision 2); **unclustered
  prompts (singletons) act as chain breakers** — a one-off prompt between
  A and B means A→B was not actually adjacent work.

## 4. Sink 1 — skill suggestions

- `scan` appends sequence candidates to the detect window:
  `kind: "sequence"`, `signature` = the steps joined with `" → "`,
  `examples` = one prompt per step (redacted).
- `detect.ts` briefing for sequence candidates: produce a single skill whose
  body performs the steps **in order**, with the step boundaries kept
  explicit (numbered steps), and whose `triggers` include the first step's
  phrasings — the user types the first step; the skill carries them to the
  end.
- Everything downstream (review evidence, apply, manifest, remove) is
  unchanged.

## 5. Sink 2 — playbook Workflows (deterministic)

- `core/playbook.ts#generatePlaybook` gains a second mined subsection under
  the existing marker region:

  ```markdown
  ## Workflows (mined)
  - After "run the tests", you usually say "now build and push" (7×, 4 sessions).
  ```

- Top K chains by count (K ≈ 5, pinned in the plan); rendered from
  signatures only. The marker-region splice contract is unchanged — user
  `Rules` and hand-written `Workflows` outside the markers are untouched,
  and markers-gone → `null` still applies.
- `DEFAULT_PLAYBOOK` template text gains the subsection header so a fresh
  file shows where mined workflows will land — the template's wording is
  updated in the same commit (no stale template).
- Value: autopilot `full` mode's judge (Spec 2) reads the playbook today;
  mined workflows make "start the user's usual next step" grounded in
  evidence instead of hand-authored lines only.

## 6. Out of scope (YAGNI)

- **Gap-tolerant sequences** (A → x → B with interleaved turns) and chains
  longer than merged bigrams produce — revisit with evidence.
- **Cross-session sequences** ("first prompt of the next session").
- **General sequence models** (Markov chains, PrefixSpan) — counting
  adjacent pairs is enough for the artifacts we emit.
- **Writing the committed project `gradient.md`** — Spec 3 Decision 2.
- **Tool-event nodes** (command A → command B) — Spec 6 owns tool events;
  merging the two graphs is a later increment.

## 7. Sequencing & dead code

- Lands **after Spec 4 Phase A merges** (needs `classifyPrompts`; A5 also
  rewrites the detect prompt this spec extends).
- If the suggestion-flywheel branch (temporal features, per-occurrence
  signatures) merges first, `mineSequences` reuses its per-occurrence
  member signatures instead of re-assigning — the plan checks this at
  build time.
- Dead code: none removed; `DEFAULT_PLAYBOOK` and its tests updated in
  place (§5) so no stale template text survives.

## 8. Testing

- Chain extraction: adjacency, chain breakers, session boundaries never
  bridged; nudge exclusion; merge of overlapping bigrams.
- Floors and caps: below-floor pairs dropped; cap hits logged.
- Playbook: Workflows subsection renders inside markers; user content
  outside markers byte-identical after refresh; K-cap respected.
- Detect: sequence candidate briefing produces a single multi-step skill
  (fixture); window share cap.
- Empty/short histories: zero findings, zero output, no crash.

## 9. Open questions for the implementation plan

- Exact constants: support floor, bigram cap, window share, playbook K —
  pinned against a fixture cut from real history.
- Whether `assign` reuses the scan's existing LSH index or a second cheap
  pass — measure on the 1,622-transcript corpus.
- Whether skill-sink and playbook-sink should deduplicate (a chain that
  became an approved skill probably should not also nag from the playbook).
