# gradient consolidation and value plan

Status: executed — see the [dogfood log](2026-07-30-gradient-dogfood-log.md)
Date: 2026-07-30
Grounding: a full dogfood of scan → review → apply → remove against
`clinch-terminal` (187 transcripts, 447 mined prompts, 5,100 tool events) plus
targeted measurement of `recall`, `checkpoint`, and `board`.

## Why

The surface has outgrown the value. 21 command modules, ~22 user-visible verbs,
11,891 source LOC. Measured against a real corpus:

| Surface | Measured outcome |
| --- | --- |
| `insights` | Genuinely useful. Real counts: 45 nudges, 43 interrupts, 10 context deaths, 3 failure loops. |
| `board` | Useful after the fork fix. Found 5 concurrent sessions across worktrees. |
| `scan` → `review` → `apply` | 13 suggestions, 2 worth installing, 7 were project history misread as habits. |
| `recall` | **Never fires.** 26 indexed artifacts, 0 hints across 6 realistic prompts. |
| `checkpoint` via `apply` | **Permanent no-op** — installed without the consent it requires (issue #29). |
| `stats` | 254 LOC that mostly re-prints the suggestion list with a coverage %. |
| `migrate` | 137 LOC for a one-time legacy conversion. |
| `mirror` | 93 LOC interactive entry point that duplicates `review`. |

Two of these are not "needs polish" — they are shipped features that cannot
work. That is the first thing to fix, ahead of any consolidation.

## Part 0 — Apply the novelty test to what already ships

Part 3 screens new ideas against "can Claude Code or Codex already do this?"
That screen was never applied to the existing surface, and it should be, because
deleting a feature is cheaper than fixing one.

Run this gate **before** any work in Part 1:

| Feature | Does the assistant already do it? | Decision gate |
| --- | --- | --- |
| `recall` | Largely yes. Both assistants select skills by matching the user's request against skill `description` — that is the core skill-dispatch mechanism. `recall` re-implements it externally with a weaker metric. | **Justify or delete.** See below. |
| `continuity` | No. Neither carries structured state across a compaction boundary beyond the summary. | Keep. |
| `board` | No. Neither has any cross-session awareness. | Keep. |
| `autopilot` | Overlaps nothing, but is the highest-risk surface. | Keep, gated. |
| `insights` | No. Neither reports on your own behavior across sessions. | Keep — this is the core. |

### 0.1 recall: prove it earns its place, or delete it

`recall` costs 145 LOC in `commands/` plus `core/recall.ts`, a
`UserPromptSubmit` hook on every prompt, and a per-project index. Its premise is
that the user typed something matching an installed artifact and the assistant
would otherwise miss it. But skill dispatch by description is exactly what both
assistants already do natively.

So the fix in 1.1 is only worth doing if recall fires in the gap — cases where
the model did **not** select the artifact and should have.

Required evidence before investing: from the transcript corpus, find prompts
that (a) matched an installed artifact and (b) were followed by a session that
never invoked it. If that set is small, **delete `recall` entirely** rather than
fix it: that removes a per-prompt hook, an index, ~300 LOC, and one of the five
verbs, which is a larger win than making it work.

If the set is meaningful, proceed to 1.1.

### 0.1 result — gate FAILED, delete recall

Measured on `clinch-terminal`: 104 sessions, 876 raw user turns, **279 genuine
human prompts** after gradient's own `filterPrompts` (≥15 chars, non-slash).

```
hints @0.55 — Jaccard (today)      0   (0.0%)
hints @0.55 — containment (fix)   30  (10.8%)
```

Three findings, each independently sufficient:

1. **Today recall has never fired.** Zero hints across 279 eligible prompts. It
   has delivered no value in its entire life.
2. **The proposed fix makes it worse, not better.** Of the 30 containment hits,
   at most 2 are correct by inspection — `"Push it all to main."` → `ship` and
   `"When I click the add button ... in the footer"` → `clinch-toolbelt`. That
   is ~7% precision against the ≥0.8 bar set in 1.1. Representative failures:

   ```
   [0.72 ] build        "Delete the git worktrees."
   [0.714] build        "Yes just implement it."
   [0.571] diff         "Ok push this to main."
   [0.556] codex-build  "Open it in Chrome."
   [0.827] sentry-cli   "# Deploy to Vercel ..."
   ```

   The same prompt also matches three different artifacts across occurrences,
   so the ranking is not merely imprecise, it is incoherent.
3. **Native dispatch already does this job well.** In the same sessions the
   assistant invoked skills correctly 90+ times — `brainstorming` 30,
   `systematic-debugging` 20, `writing-plans` 9, `subagent-driven-development` 7,
   `using-git-worktrees` 5 — with no help from recall. Of those ten skills,
   exactly one (`plan-review`) appears in recall's index at all. recall indexes
   26 artifacts that are essentially never invoked while being blind to the ones
   that are.

**Decision: delete `recall`** in Part 2 — `commands/recall.ts`, `core/recall.ts`,
the `UserPromptSubmit` hook, the per-project index, `config.recallProjects`, the
`refreshRecallIndex` calls in `apply`/`scan`, and the recall row in `insights`.
Skip 1.1 entirely. Recall is now off in `clinch-terminal`.

Two spin-off findings worth their own work:

- **The injected-text filter leaks.** ~13 of the 30 hits were skill-injected
  preambles ("Review this change for security vulnerabilities…", "## Handoff
  summary", "# Deploy to Vercel") that `filterPrompts` classified as human. Any
  prompt-derived mining inherits this contamination, which is a second
  explanation for `scan`'s low precision — fix it as part of 1.3.
- **Nudges are being scored as workflow requests.** "Yes just implement it",
  "yes, implement it", "And I clicked it" are continuations, not requests. 1.3
  should exclude nudge-classified prompts from candidate generation outright.

## Part 1 — Make the survivors actually work

### 1.1 recall: replace Jaccard with containment (only if 0.1 passes)

`matchPrompt` scores with trigram **Jaccard** (`cluster.ts:15`):

```
inter / (|A| + |B| - inter)
```

Jaccard punishes length mismatch. A short prompt fully contained in a long
artifact description still scores near `|A|/|B|`. Measured against the live
index:

```
thresholds: hint >= 0.55, near-miss >= 0.40

"ship the current feature to production"  → ship   0.247   (near-verbatim, still 2.2x short)
"ship this feature"                       → bug    0.105   (wrong artifact entirely)
"deploy to production"                    → ship   0.074
"run the dev server"                      → extension 0.071
"audit client health"                     → clinch-toolbelt 0.039
```

The top score across realistic prompts is less than half the threshold, and the
ranking is close to noise — `ship this feature` best-matches `bug`.

Fix:

- Score with the **overlap coefficient** `inter / min(|A|, |B|)` for recall
  specifically. Containment is the right metric when comparing a short query to
  a long document. Leave `similarity()` alone for clustering, which genuinely
  wants symmetric similarity; add `containment()` beside it.
- Match against `name` + `description` + `triggers` only. Never the artifact
  body — a 200-line skill drowns any prompt.
- Re-derive thresholds from the corpus after the metric change rather than
  keeping 0.55/0.40, which were tuned for a different metric.
- Ship a fixture test built from the real index shape asserting that a verbatim
  description restatement scores above the hint threshold. That test is the
  regression guard the feature never had.

Exit criteria — **not** the six prompts above, which were hand-picked by the
person writing the fix and would be overfit. Build a labeled set from the corpus:
prompts that historically preceded an invocation of a known artifact are
positives, prompts that preceded unrelated work are negatives. Tune on one
project, report precision and recall on a held-out second project, and require
precision ≥ 0.8 — a wrong hint is worse than no hint, because it steers the
model toward the wrong workflow.

### 1.2 checkpoint: stop installing inert hooks (issue #29)

`apply` installs a `PreCompact` hook while `checkpoint` returns `null` unless
`continuityProjects` contains the project. Approving through `review` never sets
that. Chosen resolution: **approval grants the consent**, because approving a
specific suggestion in review is the same explicit act `continuity on` asks for.
`stats` must also stop counting inert hooks as automated coverage.

### 1.3 scan: rank by evidence class, not estimated minutes

Every good suggestion came from counted tool events; every bad one from prompt
text. The ranking key (`estMinutesSavedPerMonth`) is derived from occurrence
count, so count inflation feeds straight into rank — and forked sessions replay
a parent's prompts, inflating counts.

- Split output into **Measured** (tool-event derived) and **Possible**
  (prompt-derived), Measured first.
- Gate prompt-derived suggestions on `temporal.activeDays >= 2`. In the dogfood
  the top-ranked suggestion already carried `active days: 1` — the disproof was
  computed and then ignored.
- Deduplicate by content hash across sessions before counting, so a replayed
  prompt counts once.
- Remove `estMinutesSavedPerMonth` from display. Keep it in the cache if
  something needs it; stop presenting a derived guess as a measurement.

Exit criteria: re-running the dogfood corpus yields no suggestion whose evidence
is a single active day, and the two hook suggestions rank first.

## Part 2 — Collapse the surface

The insight that makes this cheap: **more than half the current verbs are hook
targets a user should never type.** `checkpoint`, `recap`, `notify`, `respond`,
`recall`, `session-start`, `board digest`, `board refresh` exist to be invoked
by settings.json, not by hand. Moving them behind one internal namespace halves
the surface without removing a single capability.

### Target: five user verbs

| Verb | Replaces | Behavior |
| --- | --- | --- |
| `gradient` | `insights`, `stats`, `mirror`, `board`, `list` | The report. What is costing you, what is installed and whether it is being used, what other sessions are doing, what to do next. |
| `gradient scan` | `scan`, `review`, `explain` | Find and propose, then walk the proposals inline. `--json` for agents; `--user` / `--all` / `--since` retained as scope flags. |
| `gradient apply <id>` | `apply` | Install one proposal. |
| `gradient remove <name>` | `remove` | Uninstall. Requires a name — never a listing command. |
| `gradient on\|off <feature>` | `recall`, `continuity`, `autopilot`, `board on/off` | One consent verb for every background feature. |

Internal, hidden from help: `gradient hook <target>`.

Two corrections to an earlier draft of this table:

- **`list` folds into the bare report, not into `remove`.** Making a destructive
  verb double as the listing command is a footgun; "what is installed" is a
  question the report already answers.
- **`init` is not an `on|off` feature.** It is first-run setup: it installs the
  bundled skill and writes config, which is a consent decision, not a toggle.
  Rather than keep a sixth verb, any command run in an unconfigured project
  prompts for setup once and proceeds. The consent survives; the verb does not.
  Non-interactive callers get a clear error naming the one-liner to run.

Codex parity is a constraint, not an afterthought: `on|off` and the report must
behave for `~/.agents/skills` targets exactly as for `~/.claude`, and the
consolidation must not quietly become Claude-Code-only.

### Deletions

Delete outright, with tests:

- `commands/stats.ts` (254 LOC) — the suggestion re-listing duplicates scan
  output. **But preserve its adoption measurement.** `stats` is the only thing
  that answers "does anything gradient generated ever actually get used?", which
  is the single most important product metric — if generated artifacts are never
  invoked, the whole generation half is worthless regardless of precision. Move
  that computation into the bare report before deleting the command, and treat a
  low adoption rate as evidence to shrink Part 1 further, not as a display bug.
- `commands/mirror.ts` (93 LOC) — bare `gradient` becomes the entry point.
- `commands/migrate.ts` (137 LOC) — a one-time converter for a format two
  releases old. Ship one final release that runs it automatically on first run,
  then delete both the command and the migration.
- `commands/bundle.ts` + `core/bundle.ts` — unexercised in the dogfood, and the
  plugin path (`/plugin marketplace add`) already distributes artifacts. Confirm
  no documented workflow depends on it before deleting; it is cheap to keep and
  irreversible to remove from a published CLI.
- `commands/list.ts` (6 LOC) — folds into `remove`.
- `commands/explain.ts` (11 LOC) — folds into the scan walkthrough.

Also delete after the consolidation lands, since nothing will reference them:

- `DIGEST_COMMAND` / `REFRESH_COMMAND` / `RESPOND_HOOK_COMMAND` compatibility
  aliases in `board.ts` and `autopilot.ts` — retained in this branch only so the
  current tests keep their names; the `*_SUB` constants are the real interface.
- The `init --session-scan` migration entry `replacing: ["gradient scan --detach"]`,
  once a release has passed.
- `emitCommand` / `EmitTarget = "command"` if the command→skill migration
  completes, leaving skills the only emit target.

Estimated removal: ~600 source LOC and their tests, with no capability lost.

### Compatibility

Keep the old verbs as hidden aliases that print a one-line redirect for one
minor release, then delete. Hook targets already in users' settings.json must
keep working — `isGradientHookFor` already matches any binary form, so the
alias layer only needs to keep the subcommand names resolvable.

## Execution record

Parts 0–2 are done and shipped on `fix/dogfood-findings`. Part 3 was gated and
mostly deleted rather than built. What actually happened, against what was
planned:

| Planned | Outcome |
| --- | --- |
| 0.1 gate `recall` | Failed. Deleted (−951 LOC). |
| 1.1 fix recall's metric | Skipped, as the gate directed. |
| 1.2 checkpoint consent | Done. Approval grants continuity consent. |
| 1.3 rank by evidence class | Done, and extended: the restatement filter, a 24h recurrence window, replay dedupe at the source, and tiering on evidence class rather than payload shape. |
| 2 five user verbs | Six, not five. `init` kept — see below. 22 → 6. |
| 2 delete stats/mirror/migrate/list/explain | Done; `stats`'s adoption computation rescued into `core/adoption.ts` and shown by the report. |
| 2 delete `bundle` | Not done. Kept, hidden from help: packaging artifacts for a team is a capability nothing else provides. |
| 3.1 recurring-failure ledger | Partly superseded. Failure loops are mined and tiered as measured; the cross-session ledger is unbuilt, and the replay fix showed most "recurring" failures were one failure counted twice. |
| 3.2 instruction effectiveness | **Gated and deleted.** Rebuilt both halves first, measured 0 true positives in 31 candidates across 61 projects, then removed it (−1,015 LOC). |
| 3.3 context-death forensics | **Gated, not built.** Context death is diffuse: median 26% for the largest single source, and only 2 of 78 compacted sessions have any source above 40%. Nothing to name in a `.claudeignore`. The mitigation (`gradient on continuity`) already ships. |
| 3.4 cross-session collision guard | **Gated, not built.** 844 concurrent same-directory session pairs produced 6 distinct co-edited files ever, 2 of them `MEMORY.md`. A `PreToolUse` hook on every write to fire ~3 times in 6 months — and the board already prints what other sessions are editing. |

Two deliberate deviations, both argued at the commit:

- **`init` stays a verb.** The plan folded it into an implicit first-run prompt
  with "non-interactive callers get a clear error naming the one-liner to run."
  That is a regression: today every command works in an unconfigured project off
  config defaults, and requiring setup would break CI and agent callers. Setup
  is a consent decision, not a toggle, and it earns its verb.
- **`gradient hook <target>` dispatches but is not yet written into settings.**
  The bare subcommands are what users' settings already contain, and
  `isGradientHookFor` matches both, so the namespace can be adopted by the
  installers after a release has passed without risking orphaned hooks on a
  downgrade.

The plan's own falsifier fired, twice. It said: *"If `scan` precision stays low
after 1.3, prompt-derived suggestions should be dropped entirely rather than
tiered."* Precision did not stay low — it went to 2/2 — but only because
everything prompt-derived was filtered out. The `possible` tier is now empty on
the dogfood corpus, which is the same result by a different route.

## Part 3 — Capabilities that do not already exist

The test for anything new: Claude Code and Codex cannot do it, and gradient can
only because it holds the cross-session transcript corpus. Ideas that fail this
test (skill authoring, hook authoring, memory files, permission allowlists —
`/fewer-permission-prompts` already mines those) are excluded.

### 3.1 Recurring-failure ledger

The dogfood found 3 in-session failure loops in 5,100 tool events, and nothing
surfaces them across sessions. Neither assistant remembers that you have fought
the same error six times in four sessions.

Build a ledger keyed by normalized error signature: how often it has recurred,
across how many sessions, whether it was ever resolved, and — the valuable part
— the tool call that immediately preceded the last recovery. Output is
"this failed 6 times; last time `pnpm store prune` cleared it."

Unique because it needs history across sessions, which only gradient has.

### 3.2 Instruction effectiveness audit

Already half-built (`instruction-audit.json`, restatement and correction
findings) and almost entirely unexploited — the dogfood run audited exactly one
instruction and produced zero findings.

Measure whether the rules in `CLAUDE.md` / `AGENTS.md` are actually followed, by
detecting when the user restated a rule the file already contains, or corrected
behavior a rule already forbade. Report per-rule: "restated 7 times across 5
sessions — this rule is not holding," with a proposed rewrite.

Nothing in either assistant tells you which of your instructions are dead
letters. This is the single most defensible idea here and the code is partly
written.

### 3.3 Context-death forensics

10 context deaths and 10 compactions measured, with no attribution. Both
assistants show a live context meter; neither tells you afterwards what consumed
it.

Attribute context growth to its sources across sessions — which tool outputs,
which file reads, which pastes — and report the repeat offenders: "reading
`*.jsonl` fixtures accounted for ~40% of context in 6 sessions." Actionable
output is a concrete `.claudeignore` entry or a "read this with a filter"
suggestion.

### 3.4 Cross-session collision guard

`board` already discovers concurrent sessions — it found 5 across worktrees.
Neither assistant has any cross-session awareness at all.

Extend from "who is running" to "who is about to collide": warn when another
live session has uncommitted edits to a file this session is about to modify.
This is a `PreToolUse` hook on Edit/Write comparing against other sessions'
in-flight file sets, which `board` already collects.

Highest practical value for anyone running parallel agents, which the dogfood
shows is exactly how this repo is used.

## Sequencing

0. **Run the novelty gate** (Part 0) and the adoption measurement rescued from
   `stats`. Both are cheap analyses, and both can delete work from every later
   step. Do this first — it is the only step that can make the plan smaller.
1. **Correctness** — 1.2 and 1.3 unconditionally; 1.1 only if 0.1 passes. No
   surface change, so no migration risk; independently shippable.
2. **Re-dogfood** on a fresh corpus and re-measure the table at the top. Do not
   proceed until `scan` precision improves and (if kept) `recall` fires.
3. **Consolidate** — Part 2, aliases retained. Add an alias-layer test asserting
   every deleted verb still resolves and prints its redirect, and that hook
   targets already present in a user's settings.json keep working.
4. **Re-dogfood** the new surface end to end, including `on`/`off` for every
   background feature and a first-run setup path in a clean project.
5. **Build one new capability** — 3.2 first (partly built, most defensible),
   then 3.4.
6. **Delete** the aliases and the dead code listed above, on a dated ticket.

Steps 0–2 are the whole near-term value. Steps 3–6 should not start until the
re-dogfood in step 2 shows the survivors earning their place.

## Step 0, run early: adoption is ~zero

The adoption question was cheap enough to answer immediately, and the answer
reframes everything above.

Across ~105 projects under `~/projects`, exactly **three** `.gradient/`
directories exist, and the manifests contain **two generated artifacts total**:

```
clinch-terminal/.gradient/manifest.json   []
gradient/.gradient/manifest.json          pr-link   (2026-06-30)
                                          continue  (2026-07-09)
```

Both are in gradient's own repository. Zero artifacts in any other project, over
a month of heavy daily use by the author. And one of the two is `continue` —
which current gradient explicitly flags as a mis-suggestion
("this is what autopilot automates"), so it would not be generated today.

This is the falsifier below firing before the work started. Consequences:

- **Part 1's precision work is polishing a path nobody completes.** Improving
  suggestion quality from 15% to 40% changes nothing if the funnel ends at two
  artifacts a month.
- **The measurement half is the product.** `insights` and `board` produced value
  on first contact, with no approval step and no artifact.
- **Revised priority**: keep generation, shrink it hard to the tool-event tier
  (which produced both genuinely good suggestions), and invest the freed effort
  in Part 3 — where 3.2 and 3.4 are measurement capabilities that need no
  approval funnel at all.

Do not treat this as a reason to delete generation outright: n=1 user, and the
apply path was broken for its entire life (hooks exited 127 until 2026-07-30),
which is itself a sufficient explanation for zero adoption. Re-measure after one
month with a working apply path before concluding.

## What would make this plan wrong

Stated up front so the re-dogfood can falsify it rather than confirm it:

- **If adoption is near zero** — generated artifacts are installed but never
  invoked — then Part 1's precision work is polishing something nobody uses, and
  the right move is to cut generation to the two tool-event hooks and reposition
  gradient as a measurement tool.
- **If `scan` precision stays low after 1.3**, prompt-derived suggestions should
  be dropped entirely rather than tiered.
- **If the collision guard (3.4) fires rarely** in a repo with 5 concurrent
  sessions, cross-session tooling is not the differentiator this plan assumes.

## Risks

- **Re-tuning recall thresholds against one corpus overfits.** Validate on at
  least two projects with different artifact counts before shipping.
- **Approval-grants-consent (1.2) widens what approval means.** It stays inside
  the same project and the same explicit act, but it must be stated plainly in
  the review preview, not just implied.
- **Hidden aliases can outlive their release.** Delete them on a dated ticket,
  not "later."
- **Consolidation churns the bundled skill again.** Update
  `cli/src/skill/SKILL.md` in the same commit as the verb changes, or the
  agent-facing surface silently drifts from the CLI.
