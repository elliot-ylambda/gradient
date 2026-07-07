# gradient — Instruction Audit: Does Your CLAUDE.md Actually Work? — Design

**Date:** 2026-07-06
**Status:** Draft (brainstorming complete; awaiting user review)
**Scope:** Spec 7. Measures whether written instructions (CLAUDE.md,
`.claude/rules/*.md`) actually hold, by mining two signals — **restated
instructions** (the user keeps typing what is already written) and
**corrections** (the user rebukes an action right after it happened) — and
routing findings into both the suggestion funnel and `insights`. Builds on
Spec 4 Phase A (classifier) and Phase C2 (assistant-turn parsing, `rule`
payload/emitter), and on Spec 6's generalized `hook` payload.

---

## 1. Context

The community's hard-won rule is *"CLAUDE.md instructions are requests;
hooks are guarantees."* Nothing in the ecosystem measures that empirically.
The evidence is already in the transcripts:

- A prompt nearly identical to a line already in CLAUDE.md is proof the
  instruction is not holding — the user is paying the instruction's context
  cost *and* still typing it.
- A short correction right after assistant activity ("no, use pnpm",
  "don't touch the migrations") is either a **violated instruction** (it
  matches a written line → the instruction provably fails → promote it to
  a mechanical artifact) or a **missing instruction** (no match → a rule
  suggestion writes itself).

This deepens gradient's moat: it is the only tool that knows both what the
user *wrote* and what the user *had to say anyway*.

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Output | **Suggestions + insights from day one.** Findings become normal scan suggestions (rules/hooks through review → apply) *and* an "Instruction effectiveness" `insights` section. Not report-only. |
| 2 | Instruction sources | Read-only parse of `<project>/CLAUDE.md`, `<project>/CLAUDE.local.md`, `<project>/.claude/rules/*.md`, and `~/.claude/CLAUDE.md`. `@import` lines are **not followed** in v1. gradient **never edits any of these files** — findings about user-global instructions surface as print-only suggestions (Spec 4 Decision 5 extended to all CLAUDE.md files). |
| 3 | Instruction unit | A markdown list item or short paragraph line (8–200 chars) outside code blocks; headings, links-only lines, and marker regions are skipped. Normalized with `cluster.ts#normalize`. |
| 4 | Restatement detector | `similarity(normalize(prompt), normalize(instruction)) ≥ ~0.7` over `"human"`-class prompts (Phase A classifier). **≥ 3 restatements across ≥ 2 sessions** → finding. |
| 5 | Correction detector | Short (< 200 chars) human prompts matching a correction lexicon (leading "no," / "don't" / "stop" / "never" / "actually" / "instead" / "that's wrong" / "undo" / "revert" …), clustered with the existing trigram machinery over the correction subset. **≥ 3 across ≥ 2 sessions** → candidate. Uses Phase C2's opt-in assistant-turn parse only to confirm the prompt follows assistant activity in-session. |
| 6 | Cross-reference | Every correction cluster is checked against instruction lines. Match → **violated instruction**: suggest a mechanical artifact — a Spec 6 command-`hook` when the instruction is hook-shaped (imperative + a runnable command), else a project rule restating it in enforceable terms. No match → **missing instruction**: a `rule` suggestion (Phase C2 payload/emitter unchanged). |
| 7 | Funnel integration | New candidate kind hint `"instruction"`; candidates carry the quoted instruction line (when matched) so the detect judge sees exactly what failed. Same detect window, same cap-and-log stance as Spec 6 Decision 5. |
| 8 | Insights section | Per instruction: restatements · violations · last seen, sorted by (restatements + violations), capped at 15 rows. Owned by `insights` (behavior view); `stats` does not grow this. Without Phase D, `scan` prints a one-line summary. |

## 3. Modules

| File | Responsibility |
|------|----------------|
| `core/instructions.ts` (create) | Load instruction sources for a scope (project dir + home), extract instruction lines (Decision 3), tag each with `{source, line, normalized}`. |
| `core/audit.ts` (create) | Restatement detector (Decision 4), correction detector (Decision 5), cross-reference (Decision 6); emits `Candidate`s and the per-instruction tallies consumed by insights. |
| `core/detect.ts` (modify) | Briefing for `"instruction"` candidates: violated + hook-shaped → command hook; violated otherwise → project rule; unmatched correction → project rule; user-global source → `target: "user"` (print-only). |
| `commands/scan.ts` (modify) | Run the audit after classification; merge candidates into the detect window; summary line. |
| `insights` (Phase D file, modify when present) | "Instruction effectiveness" section (Decision 8). |

## 4. Detection flow

1. `classifyPrompts` (Phase A) buckets turns; the audit consumes `"human"`.
2. `instructions.ts` loads and extracts instruction lines for the scan
   scope. No CLAUDE.md anywhere → the audit is a no-op (zero cost, no
   output).
3. **Restatements:** each human prompt is compared against instruction
   lines (both normalized; `cluster.ts#similarity`). N is small — dozens of
   instructions × capped prompts — no LSH needed.
4. **Corrections:** lexicon subset → trigram clustering → clusters
   cross-referenced against instruction lines at the same ~0.7 threshold.
5. Tallies per instruction feed insights; threshold-crossing groups become
   candidates with `kind: "instruction"`, `signature` = the instruction
   line (violations/restatements) or the normalized correction (missing
   instruction), `examples` = up to 3 redacted prompts.

## 5. Privacy & safety

- Everything is local; candidates pass the existing redaction before any
  LLM call — instruction lines are the user's own files but flow through
  `redact()` anyway (cheap, consistent with Spec 3 §4).
- Suggested artifacts only ever write gradient-owned files
  (`.claude/rules/gradient-*.md`, settings hooks via the manifest);
  CLAUDE.md is never touched (Decision 2).
- A correction-derived rule quotes the *pattern*, never a specific
  session's content beyond the redacted example lines shown in `review`.

## 6. Explicitly out of scope (YAGNI)

- **Rewriting or editing CLAUDE.md / CLAUDE.local.md / user memory** — never.
- **Following `@import`s** and instruction sources outside Decision 2's list
  (managed policy files, nested CLAUDE.md) — v1 reads the four obvious ones.
- **Path-scoped violation attribution** (did the session touch files a
  `paths:`-scoped rule covers?) — v1 treats all rules as global; revisit
  with evidence.
- **Instruction generation from scratch** — Phase C2 owns Q→A-derived
  rules; this spec only audits what exists and converts what fails.
- **Cross-assistant instruction files** (AGENTS.md) — still deferred.

## 7. Sequencing & dependencies

Execute after Spec 4 Phase C (needs C2's assistant-turn parse mode and
`rule` payload/emitter) and after Spec 6 (needs the command-`hook` payload
for violated-instruction promotions). Order among Specs 5/6/7: 5 and 6 are
independent; 7 last.

## 8. Dead code & outdated content (handled as part of execution)

- `detect.ts`'s candidate-source briefing is again replaced wholesale (the
  Spec 6 stance): one authoritative block, no stale appendices.
- Spec 4 Phase D's metric table is extended in the *plan* for this spec —
  the Phase D doc itself is not retro-edited; the insights code grows the
  section behind a "sources present" check so pre-Spec-7 installs render
  unchanged.
- No file removals; both detectors are additive.

## 9. Testing

- Instruction extraction: bullets and short paragraphs in; headings, code
  blocks, >200-char lines, marker regions out; all four sources read;
  missing files → empty list, no error.
- Restatements: the canonical fixture — CLAUDE.md "always use pnpm" +
  prompts "use pnpm not npm" ×3 across 2 sessions → one finding; 2
  restatements or 1 session → none.
- Corrections: lexicon precision on a redacted fixture from real history
  (pinned in the plan); a correction matching an instruction routes to
  *violated*; one matching nothing routes to *missing*.
- Cross-reference artifact choice: hook-shaped violated instruction →
  command-hook payload; prose-shaped → project rule; user-global source →
  print-only.
- Insights: tallies, sort, 15-row cap; empty-CLAUDE.md project renders
  nothing and exits green.
- Redaction: instruction lines and examples pass through `redact()`.

## 10. Open questions for the implementation plan

- Correction-lexicon contents and measured precision on real (redacted)
  history — the false-positive rate decides how tight Decision 5's
  follows-assistant-activity requirement must be (any activity this
  session vs. within the last k turns).
- Exact similarity threshold (~0.7) for restatement and cross-reference —
  pinned by fixtures; they need not be the same value.
- "Hook-shaped" classifier for violated instructions: baseline = contains a
  backtick-quoted runnable command or matches `(always|never) run` — pin
  against real CLAUDE.md corpora.
- Whether restatement counting should exclude prompts that *are* slash
  invocations of a gradient artifact (they will disappear as B's adoption
  data improves anyway).
