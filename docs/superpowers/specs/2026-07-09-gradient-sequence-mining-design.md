# gradient — Sequence Mining: Workflows From What Follows What — Design

**Date:** 2026-07-09
**Status:** Implemented and merged into the v2 pipeline
**Scope:** Spec 8. Mines *ordered* structure — which prompt follows which
within a session — into advisory multi-step **skill suggestions**. Builds on
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
| 3 | Support floor | A bigram or exact contiguous trigram becomes a finding at **≥ 3 full-chain occurrences across ≥ 2 sessions**. A→B and B→C aggregates never imply A→B→C; every count and example must come from a real ordered same-session tuple. |
| 4 | Artifact — no new payload type | Chains enter the detect window as candidates (kind `"sequence"`) and become ordinary `command`(→skill) payloads, but their body is an **advisory checklist**. Step one never authorizes later steps; the skill must show the checklist and ask which steps to perform. Scan never writes raw or unapproved chain text into the autopilot playbook. |
| 5 | Caps | Tracked bigrams capped (~2,000, most-recent-first) and sequence candidates capped at **⌈detect window / 4⌉** so prompt candidates keep priority — both caps logged when hit (Spec 6 Decision 5's no-silent-caps stance). |
| 6 | Privacy & deps | Zero new runtime dependencies. Signatures/examples are bounded and redacted immediately before the LLM call. They are not assumed safe merely because clustering produced them. Opaque candidate IDs—not redacted signatures—carry provenance. |

## 3. Module: `core/sequence.ts`

```ts
export interface ChainFinding {
  steps: string[];        // ordered cluster signatures, length ≥ 2
  count: number;          // occurrences of the full chain
  sessions: number;       // distinct sessions containing it
  sessionIds: string[];   // distinct session ids (detect merges evidence via sessionIds)
  examples: string[][];   // ≤ 3 example prompt-tuples (redacted before any LLM call)
}

export function mineSequences(
  turns: Turn[],               // "human" class only; ordered per session internally by ts
  assign: (text: string) => string | null,  // cluster-signature lookup; null = unclustered
): { chains: ChainFinding[]; capped: boolean };
// Nudge detection is internal: an exported NUDGE_PROMPT_RE whole-prompt lexicon (Decision 2).
```

- Single pass per session: map each turn to its node (Decision 2), emit actual
  adjacent bigrams and trigrams, tally `(count, sessions)` for each complete
  tuple, sort by `count`, and apply caps (Decision 5).
- Nudge turns are skipped transparently (Decision 2); **unclustered
  prompts (singletons) act as chain breakers** — a one-off prompt between
  A and B means A→B was not actually adjacent work.

## 4. Sink 1 — skill suggestions

- `scan` appends sequence candidates to the detect window:
  `kind: "sequence"`, `signature` = the steps joined with `" → "`,
  `examples` = one prompt per step (redacted).
- `detect.ts` produces a single skill with numbered observed steps and a
  locally constructed authorization guard. Its trigger may describe the first
  step, but invocation only recalls the checklist: the skill asks which steps
  the user wants now and confirms consequential steps separately.
- Everything downstream (review evidence, apply, manifest, remove) is
  unchanged.

## 5. Autopilot playbook exclusion

- Scan does not write chains into the global or project playbook. A sequence is
  cached privately as a suggestion and reaches an artifact only after the user
  sees the exact rendered checklist and approves it. This prevents raw history,
  secrets, marker injection, or unapproved instructions from entering autopilot
  context. Arbitrary-response `full` autopilot mode is disabled in `0.1.1`.

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
- Dead code: none removed and no template churn — chain lines reuse the
  existing mined-region subsection (§5), so `DEFAULT_PLAYBOOK` is untouched.

## 8. Testing

- Chain extraction: adjacency, chain breakers, session boundaries never
  bridged; nudge exclusion; merge of overlapping bigrams.
- Floors and caps: below-floor pairs dropped; cap hits logged.
- Provenance: separately observed A→B and B→C never fabricate A→B→C; every
  example tuple comes from one real session in the stated order.
- Detect/review: a sequence produces one guarded checklist, model-authored body
  text is ignored, and the exact output is shown before approval.
- Empty/short histories: zero findings, zero output, no crash.

## 9. Open questions for the implementation plan

- Exact constants: support floor, bigram cap, window share, playbook K —
  pinned against a fixture cut from real history.
- Whether `assign` reuses the scan's existing LSH index or a second cheap
  pass — measure on the 1,622-transcript corpus.
- Whether a future, separately consented insights view should display approved
  chains without feeding their text into autopilot context.
