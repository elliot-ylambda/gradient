# gradient dogfood log

Running record of what was driven end to end, what broke, how it was tested, and
what the numbers did. Companion to
[the consolidation plan](2026-07-30-gradient-consolidation-and-value.md).

Corpus: `clinch-terminal` — 187 transcripts, 104 sessions, 5,129 tool events —
plus, for the gate measurements, every project under `~/projects` (61 of them
carry a `CLAUDE.md` or `AGENTS.md`; 765 have a gradient cache).

Baseline scan: 447 mined prompts → 13 suggestions, of which 2 were worth
installing.

## Method

Drive each command against a real repository, then verify the *effect* rather
than the exit code. Three rules earned their place:

- **Exit 0 is not evidence.** `gradient checkpoint` exited 0 while writing
  nothing for its entire life. Every claim below names the artifact inspected.
- **Assert the invariant, not the string.** Every bug in F1–F3 shipped green
  because a test pinned the literal output the bug produced.
- **Apply the novelty gate to shipped features, not just new ones.** It is
  cheaper to delete a feature than to fix one, and two of the three features
  examined this way turned out to be inert.

## Findings

| # | Finding | Evidence | Fix | Verified by |
| --- | --- | --- | --- | --- |
| F1 | Applied hooks never ran | `gradient notify` → `exit 127, command not found` | `resolveHookBinary()`: PATH → own bin → pinned npx | Both hooks re-applied, `exit 0` |
| F2 | 6 of 7 hook installers had the same bug | each composed `"gradient <sub>"` by hand | all routed through `gradientHookCommand()` | round-trip across 4 binary forms |
| F3 | Removal matched by exact string | `off` after a global install would orphan a live hook | `isGradientHookFor()` predicate on both sides | round-trip tests |
| F4 | `resolveHookBinary` trusted `argv[1]` | under vitest it proposed baking in `vitest/dist/workers/forks.js` | locate own `bin.js` via `import.meta.url` | resolver output from the built CLI |
| F5 | `checkpoint` installed via `apply` was a permanent no-op | real payload → `exit 0`, no `progress.md` | approval grants continuity consent | `progress.md` written with 10 real intents |
| F6 | `board` listed strangers' PRs | `origin` on a fork is `warpdotdev/warp` | `--author @me` + repo from push remote | new query `[]`, old query 10 rows |
| F7 | `board` truncated silently | fetched 20, displayed 10 | announce withheld count | — |
| F8 | `list` printed zero bytes when empty | indistinguishable from a crash | empty state, then folded into the report | observed |
| F9 | `gradient.md` template was false | claimed `scan` refreshes the mined region | corrected | — |
| F10 | `insights` framed unrecoverable cost as recoverable | 16.3M tokens under "→ autopilot" | split recoverable vs attention | output re-read |
| F11 | `recall` had never fired | 0 hints across 279 eligible prompts | **deleted** | measurement script |
| F12 | The injected-text filter leaked | 13 skill-injected preambles mined as human prompts | `promptSource` is authoritative | 447 → 349 prompts |
| F13 | Fork replays inflated counts | 3 sessions sharing one millisecond | dedupe, later moved to the source | top offender 5× → 2× |
| F14 | One-day patterns ranked first | top suggestion carried `active days: 1` | recurrence gate | 5 candidates held back |
| F15 | Approvals sold as workflows | `lgtm`, `looks good`, `continue` | nudge filter | 3 dropped |
| F16 | Settings writes had no trailing newline | `\ No newline at end of file` | append `\n` | byte-checked |
| F17 | Every prompt-derived artifact restated its prompt | all 6 cached suggestions score 0.96–1.00 containment | restatement filter | 13 → 2 suggestions |
| F18 | The recurrence gate split a sitting at midnight | two sends 51s apart read as two active days | 24h windows, not calendar days | `activeWindows` tests |
| F19 | Sequence chains bypassed the gate entirely | the surviving chain ran twice in 5 hours on one day | gate applied at the chain level | chain held back |
| F20 | Replays inflated *every* cross-session floor | 385 of 5,129 tool events; 2 of 3 "failure loops" were one failure | dedupe at the source, before anything counts | failure loops 3 → 0 |
| F21 | Tool-derived suggestions were filed as prompt-inferred | a failure guide sat under "check the evidence" beside prompt text that never existed | tier on `evidence.measured`, not payload shape | tiering tests |
| F22 | Failing `cd` mined as a reusable workflow | "Reusable workflow for `cd [REDACTED]/projects/clinch-terminal`" | undiagnosable-builtin denylist; honest titles for toolfail/ritual | candidate gone |
| F23 | `gradient` and `gradient scan` disagreed about the same corpus | 451 prompts vs 349; 2 failure loops vs 0 | the report now uses `promptSource` and the same replay dedupe | both report 333 and 0 |
| F24 | The instruction audit could not reach its own threshold | best score 0.184 across 1,680 pairs, floor 0.7 | **deleted** (see gate) | measurement script |
| F25 | The suite failed spuriously on unmodified main | git-dependent tests timing out at 5s under concurrent git activity | raise the vitest timeout | 905 pass |

## Three gates, three verdicts

The novelty screen — "can Claude Code already do this, and does it fire at all?"
— was written for new ideas. Applied to shipped ones it deleted two features and
saved building a third.

### `recall` — deleted

```
279 genuine human prompts
hints @0.55 — Jaccard (shipped)     0   (0.0%)
hints @0.55 — containment (fix)    30  (10.8%), of which ~2 correct
```

The decisive evidence was not the score. In the same sessions the assistant
invoked skills correctly 90+ times by native dispatch — `brainstorming` 30,
`systematic-debugging` 20, `writing-plans` 9 — and **exactly one of those ten
skills appears in recall's index**. It indexed 26 artifacts nobody invokes while
blind to the ones everybody does. Fixing the metric would convert "never fires"
into "fires wrongly", which is worse: a wrong hint steers the model away from the
skill it would otherwise have chosen correctly.

### The instruction-effectiveness audit — deleted

The plan called this "the single most defensible idea here and the code is partly
written." Measured, it is neither.

```
61 projects with instruction files · 846 prompts · 442 rules
restatements found by the shipped matcher            0
best prompt/rule score, any pair                 0.184   (floor 0.7)
restatements found after rebuilding both halves     31   — all false positives
corrections detected in the whole corpus             6
corrections matching any rule                        0
```

Both halves were rebuilt before judging: paragraph-level instruction units
instead of the line fragments the extractor produced, and IDF-weighted
content-word containment instead of character trigrams. The rebuild worked — and
returned 31 candidates with zero true positives. "Test: `make test`" matches any
long prompt containing both words; "Sign up at https://modal.com" matches any
prompt about signing up.

The premise is the problem: **people write rules down precisely so they do not
have to say them again.** Restatement is rare by construction.

A third form — check rules against what the assistant actually *ran*, since
gradient already parses every Bash invocation — was built and measured too.
Across the same 61 projects only two rules genuinely name a forbidden command
(`pnpm start`, `fly secrets set …`); the other ~28 extractions were filenames,
model names and table names sitting in a backtick after a negation. Abandoned.

### `insights` / `board` — kept, and merged into the report

Both produced value on first contact, with no approval step and no artifact.
They are the reason the bare report exists.

## The structural finding

Scoring every prompt-derived suggestion ever cached on this machine:

```
765 project caches · 3 ever produced a suggestion · 11 suggestions total
   command  5 (4 with examples)   loop  2   hook  3   playbook  1
scorable prompt-derived suggestions:              6
containment against their own source prompts:  0.961 – 1.000  (all six)
```

Not a bad batch — a structural ceiling. `detect.ts` rebuilds every command body
locally from the candidate, because the model is deliberately never trusted to
author artifact text:

```ts
body: … : workflowBody(instruction)          // instruction = safeExamples[0]
examples: safeExamples
```

The body *is* `examples[0]` with a preamble. A single-prompt command artifact
cannot say anything its prompt did not. The restatement filter enforces that
directly, and exempts multi-step checklists, where the composition is the
contribution even when every step is borrowed wording.

## Numbers

| Metric | Baseline | After correctness | Now |
| --- | --- | --- | --- |
| Prompts mined | 447 | 349 | 333 |
| Candidates reaching the LLM | 15 | 7 | 2 |
| Suggestions | 13 | 6 | **2** |
| Suggestions worth installing | 2 | 2 | 2 |
| Noise | 11 | 4 | **0** |
| User-visible verbs | 22 | 22 | **6** |
| Command modules | 21 | 21 | 19 |

The generation half never got better at *finding* good suggestions — there were
only ever two. It got much better at not burying them, and then at not inventing
company for them.

## Surface, before and after

```
insights  stats  mirror  list  board            →  gradient
scan  review  explain                           →  gradient scan
apply                                           →  gradient apply
remove                                          →  gradient remove
continuity  autopilot  board on  --session-scan →  gradient on|off <feature>
init                                            →  gradient init
checkpoint  recap  notify  respond  session-start  board digest/refresh
                                                →  gradient hook <target>  (hidden)
migrate  recall                                 →  deleted
```

Every retired verb still routes and prints a one-line redirect, for one release.

## Verified end to end after the consolidation

- Bare report in a fresh git repo, and against a 187-transcript project.
- `on` and `off` for all four features: hooks written and removed, consent
  granted and revoked, adjacent hooks and `permissions` untouched.
- `apply notify-when-waiting` → hook in settings → `gradient notify` exits 0 →
  report shows it under `installed` → `remove` → hook gone.
- Every retired alias, including the old grammars (`continuity on`,
  `autopilot nudge`, `board digest`) and the new `gradient hook board-digest`.
- A leftover `npx -y gradient.md@0.6.1 recall` hook retiring itself: no output,
  exit 0, hook and consent gone, continuity consent and `permissions` intact.

## Still open

- **Adoption is still ~zero** (2 artifacts across ~105 projects, both in
  gradient's own repo). The confound — `apply` was broken until 2026-07-30 — is
  now removed, so re-measure in a month before concluding.
- `recap` has not yet been observed firing on a real resume.
- The `possible` tier is now empty on this corpus. If it stays empty after the
  adoption re-measurement, drop prompt-derived generation entirely rather than
  keeping a tier that never has anything in it.
- `gradient hook <target>` is accepted but never written into settings. Switch
  the installers after a release has passed, so a downgrade cannot orphan hooks.
- The retired aliases need a dated removal ticket, not "later".
