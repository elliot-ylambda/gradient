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
| F26 | 0.7.0 kept serving the noise 0.7.0 removes | 3 of 4 cached suggestions scored 1.000 restatement; cache written 2026-07-19 | re-apply the filter in `loadSuggestions` | 3 pending → 1, real cache |
| F27 | A documented alias was never wired | `gradient explain` → `unknown command`, from the published 0.7.0 tarball | `RETIRED` map, and the test drives it | test fails without the fix |

## Five gates, five verdicts

The novelty screen — "can Claude Code already do this, and does it fire at all?"
— was written for new ideas. Applied to shipped ones it deleted two features;
applied to the remaining planned ones it stopped three more from being built.

Nothing that ran the gate survived it. That is worth stating plainly rather than
filing as a coincidence: every one of these was believed valuable by the person
who wrote the plan, including the two the plan singled out as its most
defensible. Belief and frequency turned out to be unrelated.

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

### 3.4 cross-session collision guard — not built

The plan called this "highest practical value for anyone running parallel
agents, which the dogfood shows is exactly how this repo is used." The premise
is right; the conclusion does not survive counting.

```
1,972 sessions · 288 with file edits · 844 time-overlapping pairs in one cwd
pairs sharing an edited file within 10 min (raw)      82
  of those, fork/resume replay of one lineage          9
  genuinely concurrent, distinct writes               73
distinct (repo, file) ever genuinely co-edited         6
```

Seventy-three pairs collapse to **six files**, because the same file collides
across many pairs. Two of the six are `MEMORY.md` — infrastructure written by
the memory system on almost every session, so a guard would fire on it
constantly and correctly be ignored. One is inside a shared worktree. That
leaves **three real source-file collisions in months of heavy parallel use**,
none showing evidence of lost work.

The first pass nearly reported 82. Every collision in it was `0m apart`, which
is the fork/resume signature: a resumed session inherits its parent's events
verbatim, timestamps included. Same bug as F13 and F20, third sighting.

Cost matters here as much as frequency. This would be a `PreToolUse` hook on
Edit/Write — it runs before *every* file write. In the session that measured it,
that is 160 invocations to maybe fire three times in six months, in the hot path,
with "blocks an edit" as its failure mode.

And the information already ships. `gradient`'s board section prints
`editing: cli/src/commands/apply.ts, …` for every live session, passively, at no
marginal cost. The guard would re-deliver what the report already says.

### 3.3 context-death forensics — not built

The promise: attribute context growth to its sources, and emit something you can
act on — the plan's own example is "reading `*.jsonl` fixtures accounted for ~40%
of context in 6 sessions" turning into a `.claudeignore` entry.

Measured in characters, the answer looked spectacular: **45% of context in
compacted sessions was `*.png`**. It was an artifact. Base64 characters are not
tokens — an image costs the model a fixed ~1.5k tokens regardless of how many
bytes its encoding runs to. Transcripts carry real per-turn usage, so the honest
unit was available all along:

```
context at a turn = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

Re-run on token deltas across the same 78 compacted sessions, `*.png` disappears
from the table entirely, and the actual shape of context death appears:

```
median share of the single largest source, per session     26.0%
sessions where any one source exceeds 40% of growth         2 / 78
share attributable to file reads (the .claudeignore lever)  32.1%
   …spread across *.md, *.py, *.tsx, *.ts — i.e. the source code
```

**Context death is diffuse.** In 76 of 78 sessions there is no dominant culprit
to name, so there is nothing to put in a `.claudeignore`. The largest single
"source" overall is `$ cd` at 17%, which is just the command head of long
compound shell invocations — not a thing anyone can act on.

The mitigation also already ships. Bare `gradient` reports `context deaths` and
`compacts` and points at `gradient on continuity`, which makes a context death
cost a paragraph instead of a re-explanation. Forensics would explain why
something happened that already has a fix.

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

## The release that would have shipped its own noise

The first thing done after merging the consolidation was to run the bare report
against gradient's own repo at v0.7.0 — a capture for the docs page, not a test.
It listed three pending suggestions. Two of them were `hi` and `continue`.

```
isRestatement  score   name
true           1.000   reply-with-exactly
true           1.000   hi
true           1.000   continue
false            n/a   notify-when-waiting
```

The cache was written on 2026-07-19, eleven days before the restatement filter
existed. Its format is a bare JSON array with no envelope, so nothing records
which release produced it, and no reader can tell a stale entry from a fresh one.
Every user who had ever scanned would upgrade to 0.7.0 and keep seeing — and be
invited to install — precisely the suggestions 0.7.0 exists to stop generating.
One of them was already installed in this repo.

The fix re-applies the filter on read rather than versioning the cache and
discarding it. `isRestatement` is a pure predicate over a finished suggestion:
body against examples, both already stored. So it costs nothing, needs no model
call, keeps the one good suggestion, and makes every future tightening clean up
old caches retroactively. The gates that need mining state — recurrence needs
occurrence timestamps, the nudge filter needs the raw cluster signature — cannot
work this way, which is exactly why this one belongs at the read boundary and
they belong beside the miner.

`loadSuggestions` is the single door; `sessionStart` is the reader that matters,
because it injects what it reads into a live session.

The general lesson is narrower than "version your caches": **a filter added to a
generator only takes effect for users who regenerate.** Shipping a precision fix
without a read-side path means the improvement is invisible to exactly the
population that already has the problem.

### Deliberately not fixed

`instruction-audit.json` survives in every project cache that ever ran the
deleted audit. Nothing reads or writes it — 65 inert bytes. A cleanup path would
mean carrying a growing list of dead filenames forward forever, which costs more
than it saves. `retireRecall` exists only because a stale `recall` hook would
have executed and printed into the model's context; an unread file does nothing.

## The alias the test could not see

0.7.0 published, then the release was smoke-tested the way a user meets it —
`npm install gradient.md@0.7.0` into an empty directory, run the binary, then
try every retired verb. Fifteen of seventeen printed a redirect. Two did not:

```
✗ explain        UNKNOWN COMMAND
✗ migrate        UNKNOWN COMMAND
```

`migrate` is correct — the surface table documents it as deleted outright, so
"unknown command" is the honest answer. `explain` is not: the same table
promises `scan review explain → gradient scan`, and it had no case at all.

There *was* a test for this, added because the plan asked for one. It read:

```ts
for (const alias of ["stats", "mirror", "list"]) { … }
```

A hand-written list of three, in a file whose implementation also hand-writes
its list. **A test that repeats the implementation's enumeration cannot catch
the implementation's omission** — the two share it. This is the second rule in
this document ("assert the invariant, not the string") in a form it had not
taken before: the string was fine, the *set* was wrong.

The fix exports one `RETIRED` map and drives the test from it, so adding a name
without wiring it fails the suite. Verified the only way this is worth anything
— by deleting the fix and watching the new test fail on `explain should not read
as a typo` before restoring it.

Worth noting what found it. The suite was green, CI was green, the dogfood gate
was green, and the packaged plugin bundle was green. It took installing the
published artifact from the registry and typing the retired verbs by hand.

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

Each of these is gated on elapsed time rather than on effort, so each now has a
dated ticket instead of a line here that says "later".

- [#33](https://github.com/elliot-ylambda/gradient/issues/33) — **2026-08-30**:
  re-measure adoption, now that the confound (`apply` was broken until
  2026-07-30) is gone, and drop prompt-derived generation entirely if the
  `possible` tier is still empty. Also the first realistic chance to observe
  `recap` firing on a real resume, which has still never been seen.
- [#34](https://github.com/elliot-ylambda/gradient/issues/34) — **0.8.0**: make
  the installers write `gradient hook <target>`, which 0.7.0 accepts but never
  writes. Gated so a downgrade cannot leave a live hook naming a verb the older
  binary lacks.
- [#35](https://github.com/elliot-ylambda/gradient/issues/35) — **0.8.0, not
  before 2026-08-30**: delete the retired aliases. Ordered strictly after #34:
  the bare forms are what users' existing settings contain, so deleting them
  first would break every hook installed by 0.6.x.
