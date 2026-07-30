# gradient dogfood log

Running record of what was driven end to end, what broke, how it was tested, and
what the numbers did. Companion to
[the consolidation plan](2026-07-30-gradient-consolidation-and-value.md).

Corpus: `clinch-terminal` — 187 transcripts, 104 sessions, 5,129 tool events.
Baseline scan: 447 mined prompts → 13 suggestions, of which 2 were worth
installing.

## Method

Drive each command against a real repository, then verify the *effect* rather
than the exit code. Two rules earned their place:

- **Exit 0 is not evidence.** `gradient checkpoint` exited 0 while writing
  nothing for its entire life. Every claim below names the artifact inspected.
- **Assert the invariant, not the string.** Every bug in F1–F3 shipped green
  because a test pinned the literal output the bug produced.

## Findings

| # | Finding | Evidence | Fix | Verified by |
| --- | --- | --- | --- | --- |
| F1 | Applied hooks never ran | `gradient notify` → `exit 127, command not found` | `resolveHookBinary()`: PATH → own bin → pinned npx | Both hooks re-applied, `exit 0` |
| F2 | 6 of 7 hook installers had the same bug | `continuity`/`recall`/`autopilot`/`board`/`init` each composed `"gradient <sub>"` | All routed through `gradientHookCommand()` | 936 tests; `recall off` removed only its own hook |
| F3 | Removal matched by exact string | `off` after a global install would orphan a live hook | `isGradientHookFor()` predicate + `replacing` predicates | Round-trip tests across 4 binary forms |
| F4 | `resolveHookBinary` trusted `argv[1]` | Under vitest it proposed baking in `vitest/dist/workers/forks.js` | Locate own `bin.js` via `import.meta.url` | Resolver output inspected from the built CLI |
| F5 | `checkpoint` installed via `apply` was a permanent no-op | Real transcript payload → `exit 0`, no `progress.md` | Approval grants continuity consent | `progress.md` written with 10 real intents |
| F6 | `board` listed strangers' PRs | `origin` on a fork is `warpdotdev/warp`; 10 PRs by 4 other people | `--author @me` + repo from push remote | New query `[]`, old query 10 rows |
| F7 | `board` truncated silently | fetched 20, displayed 10 | announce withheld count | — |
| F8 | `list` printed zero bytes when empty | indistinguishable from a crash | empty-state message | observed |
| F9 | `gradient.md` template was false | claimed `scan` refreshes the mined region; approval does | corrected text | — |
| F10 | `insights` framed unrecoverable cost as recoverable | 16.3M tokens under "→ `gradient autopilot nudge`" | split recoverable vs attention | output re-read |
| F11 | `recall` has never fired | 0 hints across 279 eligible prompts | **delete** (see gate) | measurement script |
| F12 | The injected-text filter leaks | 13 skill-injected preambles mined as human prompts | `promptSource` is authoritative | 447 → 349 prompts |
| F13 | Fork replays inflated counts | 3 sessions sharing one millisecond timestamp | `dedupeReplayedOccurrences` | top offender 5× → 2× |
| F14 | One-day patterns ranked first | top suggestion carried `active days: 1` and ranked #1 | two-distinct-day gate | 5 candidates held back |
| F15 | Approvals sold as workflows | `lgtm`, `looks good`, `continue from where you left off` | nudge filter, loops exempt | 3 dropped |
| F16 | Settings writes had no trailing newline | `\ No newline at end of file` | append `\n` | byte-checked |

## The recall gate (Part 0)

The novelty screen — "can Claude Code already do this?" — was written for new
ideas and never applied to shipped ones. Applied to `recall`:

```
279 genuine human prompts
hints @0.55 — Jaccard (today)      0   (0.0%)
hints @0.55 — containment (fix)   30  (10.8%), of which ~2 correct
```

Root cause of the zero: `similarity()` is trigram **Jaccard**,
`inter/(|A|+|B|-inter)`, which punishes length mismatch — a near-verbatim
restatement of an artifact's own description scored **0.247** against a 0.55
threshold, and `"ship this feature"` best-matched `bug` at 0.105.

The decisive evidence was not the score. In the same sessions the assistant
invoked skills correctly 90+ times by native dispatch — `brainstorming` 30,
`systematic-debugging` 20, `writing-plans` 9, `subagent-driven-development` 7 —
and **exactly one of those ten skills appears in recall's index**. recall
indexes 26 artifacts nobody invokes while being blind to the ones everybody
does. Fixing the metric would convert "never fires" into "fires wrongly", which
is worse: a wrong hint steers the model away from the skill it would otherwise
have chosen correctly.

Verdict: delete, do not fix. Skips plan §1.1 entirely.

## Numbers

| Metric | Baseline | Now |
| --- | --- | --- |
| Prompts mined | 447 | 349 |
| Candidates reaching the LLM | 15 | 7 |
| Suggestions | 13 | 6 |
| Suggestions worth installing | 2 | 2 |
| Noise | 11 | 4 |
| Top-ranked item | one prompt replayed 5×, `≈82m/mo` | the two measured hooks |

Precision in the tier a user reads first went from **2/13 interleaved** to
**2/2 under `measured`**. The generation half did not get better at finding good
suggestions — there were only ever two — it got much better at not burying them.

## The six that survive

**measured** (counted tool events — both worth installing)
- `checkpoint-before-compaction` — 10 `/compact` across 10 sessions
- `notify-when-waiting` — 32 waits ≥5 min across 24 sessions

**possible** (prompt-inferred — all four are marginal, correctly demoted)
- `even-if-we-re` — 2×/2 sessions after dedup. Still project history; survives
  because the two genuine re-sends fell either side of midnight.
- `continue` — 31×/23 sessions, correctly carrying the autopilot tip rather
  than proposing a skill.
- `push-all-these` — a real repeated action, but a poor artifact: it is one git
  command, and the generated skill would only restate it.
- `pb-after-…` — a playbook line descended from the same `even-if-we-re` prompt.

Three of the four descend from two underlying prompts. **The prompt-derived tier
produced nothing installable on this corpus**, which is the strongest available
argument for the plan's repositioning toward measurement.

## Still open

- Delete `recall` (F11) — deferred to plan Part 2 so the correctness phase stays
  independently shippable.
- `even-if-we-re` shows the day gate is crude: two sends 51 seconds apart can
  straddle midnight and read as two days. Compare against a rolling 24h window.
- `push-all-these` shows a missing filter: a "workflow" whose body is a single
  shell command is not worth an artifact.
- Adoption is still ~zero (2 artifacts across ~105 projects). The confound —
  `apply` was broken until 2026-07-30 — is now removed, so re-measure in a
  month before drawing the conclusion the plan warns about.
- `continuity` is live in `clinch-terminal`; `recap` has not yet been observed
  firing on a real resume.
