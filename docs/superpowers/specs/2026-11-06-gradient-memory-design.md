# Gradient memory — design

Date: 2026-11-06 · Status: **proposed, not implemented** · Supersedes nothing.

Gradient becomes the layer that decides **what is worth remembering** across
Claude Code and Codex, keeps it **true**, and keeps the part every session loads
**small**. It does not start as a hosted store. It starts by curating the memory
you already have, because that is where the evidence says the value is.

## 1. Problem, measured on this machine

Claude Code's auto memory for `magister-marketing`
(`~/.claude/projects/-Users-ellioteckholm-projects-magister-marketing/memory/`),
written by ~40 parallel Clinch sessions, on 2026-11-06:

| Measure | Value |
|---|---|
| Notes | 832 files, 4.8 MB (largest single note 77 KB) |
| `project_*` notes carrying PR / deploy / commit status ("#2411 MERGED 74e171daa") | 473 of 617 |
| Notes not linked from `MEMORY.md` (the only file loaded at start) | 683 of 832 |
| …of which `feedback_*` (your corrections, the highest-value kind) | 36 of 62 |

Most of what is saved is state git and GitHub already record, and most of what
is valuable is unreachable. Codex has its own native memory
(`[features] memories`, stable, **off** here), so nothing learned in one
assistant reaches the other. Gradient already reads both assistants'
transcripts — the ground truth both memories should be checked against.

## 2. What the sources say

**Anthropic, "The components of agent memory" (2026-11-06).** Four layers:
transcripts (ground truth) → notes → linked wiki pages → small injected context.
An offline "dreaming" pass validates notes against transcripts and moves
material between layers. Findings this design relies on:

- "Memory is, occasionally, a prediction" — a wrong note is carried into every session.
- Saving less, better, wins: Fable 5 kept 10 files / 43 K chars and won 4
  badges; Sonnet 3.7 kept 413 files / 978 K chars and won 1.
- "Tell Claude what memory is for, but not how to use it." A fixed rule
  ("record only failures") cut Opus 5's memory gain by 0.234.
- Injected context must stay small; Claude Code loads only the first 200 lines
  or 25 KB of `MEMORY.md`.
- One writer per page: a shared table kept 72 % of facts, one page per entity 100 %.
- Wiki + search (61 %) beats search alone (53 %) and saves ~20 K tokens per question.

**Notion Lore (open source, `~/projects/lore`).** Five Notion databases
(Projects-as-scope, Topics, Memories, Entities, Facts) behind MCP tools, a CLI
and host hooks. Worth copying:

- The save filter (`profiles/default/prompts/autosave-extraction-filter.txt`):
  an **inferability test** ("could a competent agent reproduce this just by
  reading the code…? If yes, do not save it") and a **precision bar** ("If you
  cannot state the precise rule, do not save").
- Atomic notes, one fact each, capped per run; check for a near-match and
  update rather than duplicate.
- Expiry by neglect: confidence decays 1 %/day after a 60-day grace; a citation
  bumps it 5 %; a contradiction halves it (`src/core/decay.ts`).
- Untrusted framing on every read path: a preamble plus 4-space indentation so
  stored text cannot read as instructions (`src/hooks/untrusted-text.ts`).
- Categories live in a swappable profile (`taxonomy.yaml`), not in code.

- Session start injects memory **titles as pointers**, not bodies: 3 ranked
  matches for the first prompt, 3 recent, 10 facts.

How its automatic pipeline works: a `Stop` hook counts user messages and every
5th one spawns a detached `claude -p --model sonnet` (or `codex exec`) fed the
last 100 K characters of the transcript, which saves memories through Lore's
own MCP tools. A `UserPromptSubmit` hook injects the wake-up once per session.
Everything fails open.

Its own evaluations are the most useful part. On 148 paired end-to-end
scenarios, memory formed by the pipeline produced 12 wins and 8 harms (p = 0.50;
12 vs 6, p = 0.24 after adjudication). The harms came from memories misapplied
or over-scoped at use time. A production vault of 1,522 memories was 55–60 %
worth keeping, 15–20 % near-duplicates, 8–12 % re-derivable, and confidence
scores did not separate good rows from bad.

Worth not copying:
- A background Sonnet run every 5 messages, re-sending ~100 K characters each time.
- `--dangerously-skip-permissions` with `--allowedTools`. In the `claude` CLI,
  `--allowedTools` only skips prompts and `--tools` restricts, so the agent
  reading untrusted transcripts keeps every tool.
- Hook `timeout: 10000` written as milliseconds. Claude Code reads seconds.
- No save at session end, so the last 1–4 messages of every session are never mined.
- Five relational databases and a decision graph for a single developer.
- A confidence score computed everywhere that ranks nothing (`confidenceFactor`
  returns 1.0).
- A team vault as the first surface.

**Notion, 2026-11-04:** ChatGPT, Claude and other agents can save to one Notion
memory over MCP. A generic hosted cross-agent store now has a well-distributed
incumbent; Gradient's advantages are the transcripts, the validation it already
does, and being local.

## 3. Principles

1. **Evidence before memory.** A note exists because transcripts show it
   recurred, failed, or was corrected — counted by the runner, not guessed by a
   model in the moment.
2. **Store only what cannot be re-derived.** Lore's inferability test and
   precision bar are the written rule; PR/commit/deploy status never qualifies.
3. **Small push, large pull.** Inject a short index; everything else is
   reachable by search.
4. **One writer per file.** Sessions propose; one consolidation pass writes.
5. **Reversible, visible.** Every memory edit goes through a restore point and
   is shown as a diff. Archive, never delete.
6. **Local by default; the runner makes no model calls.** Unchanged from today.
   The assistant in your session writes prose; autopilot is the one opt-in,
   budgeted exception, as it is today.
7. **Purpose, not procedure,** in every prompt that asks a model to write memory.

## 4. Scopes

- **you** — preferences and rules that hold in every project.
- **repo** — keyed by the realpath of the git common directory, so the main
  checkout and every worktree (Clinch's, `.worktrees/`, `.claude/worktrees/`)
  share one memory. Today's per-path keying is why board and the checkup
  misbehave in worktrees.

No industry or category taxonomy. Optional free-form tags only, so a later
domain profile (e.g. Magister's brand knowledge) can add categories without a
schema change.

## 5. Phases

### Phase 0 — prerequisites (release 0.11)

Memory amplifies whatever the checkup gets wrong, so these land first:

- Staleness in worktrees: paths inside an uninitialized submodule are unknown,
  not gone; skip references under `.git/`; an ancestor instruction file loaded
  twice is one finding per file pair, not one per line (1,198 → 1).
- `--json` aggregates repeated findings (862 KB → a few KB on magister).
- Board: show edited files relative to each session's own worktree; drop paths
  outside every worktree of the repo.
- Hooks: write a stable node path (`/opt/homebrew/bin/node`, `/usr/local/bin/node`)
  when it resolves to the running binary, instead of the versioned Cellar path
  that `brew upgrade` deletes.
- Codex skill: request sandbox escalation before the first write to
  `~/.config/gradient` instead of failing with EPERM.
- The pending 0.11 work: a restore point before `--apply`, `optimize --changes`
  (per-file diff), `optimize --restore`. Every later phase depends on it.

### Phase 1 — Tidy: curate the memory you already have (release 0.12)

A new `memory` family in `optimize`. Deterministic, local, no model calls.
Inputs: the Claude auto-memory directory for the repo; Codex
`~/.codex/memories/` read-only (it is generated state; report only).

| Finding | Rule | Proposed change |
|---|---|---|
| Index past its load limit | `MEMORY.md` > 200 lines or 25 KB | show what is cut off; propose a shorter index |
| Unreachable notes | note not linked from the index | add an index line (feedback/reference first) |
| Status git already knows | note dominated by PR/commit/deploy status whose PR is merged (local `git log`; `gh` optional) and > 7 days old | archive to `memory/archive/`, leaving the index line out |
| Near-duplicates | title+description shingle Jaccard ≥ 0.8 | merge proposal, newest wins, both kept in archive |
| Log, not memory | single note > 25 KB | archive; suggest a one-paragraph summary |

On magister this is the 683 / 473 / 36 above. Contradictions need a judge and
wait for Phase 2.

### Phase 2 — Learn: evidence-gated new notes (release 0.12)

Candidates come from signals Gradient already mines in both assistants'
transcripts: repeated corrections (existing floor: 3 occurrences across 2
sessions, `core/corrections.ts`), failure→fix loops, explicit "remember this" /
"from now on", and your existing Claude `feedback_*` notes (to bridge them to
Codex). Each candidate carries kind (preference · rule · gotcha · decision),
scope, the evidence (sessions, dates, quotes, counts) and a proposed sentence.

The optimize skill tells the assistant what memory is for, gives it Lore's
inferability test and precision bar, and has it drop candidates that fail. You
approve; the runner writes.

This is deliberately not Lore's model: no background model run, no transcript
tail sent anywhere. The runner counts recurrence, so a candidate exists only
when something actually recurred, failed or was corrected. Lore's own
evaluations found volume without that gate does not significantly help (12
wins, 8 harms), and that its confidence scores could not tell good notes from
bad. Reinforcement counted from transcripts replaces a confidence score.

Storage: `~/.config/gradient/memory/{you,repos/<repoKey>}/<slug>.md`, one note
per file, mode 0600, frontmatter `kind`, `scope`, `evidence[]`, `created`,
`last_seen`, `reinforced`. The runner bumps `last_seen` when the evidence recurs
in new transcripts; a note not reinforced for 90 days is proposed for archive.
Contradiction check (opt-in, one cheap judge call per candidate pair) reuses
Lore's six verdicts.

### Phase 3 — Share: one small index in both assistants (release 0.12)

- One generated `INDEX.md` per scope, written only by the consolidation pass
  under `withLock`. Combined injection ≤ 40 lines / 4 KB. Each entry is a
  one-line pointer (rule + note path), as in Lore's wake-up; bodies are pulled
  on demand.
- Injected at session start through Claude Code's `SessionStart` hook and
  Codex's `SessionStart` hook (`hookSpecificOutput.additionalContext`; Codex
  hooks reached GA in May 2026 — verify against OpenAI's docs before building).
  This also lifts "background features are Claude Code only".
- Framed as untrusted data: Gradient's existing tag wrapper plus Lore's
  preamble and 4-space indentation.
- Overlap with Claude's own `MEMORY.md` is resolved by Phase 1: approved
  `feedback_*` notes move to the `you` scope (archive copy kept) so both
  assistants get them once.

### Phase 4 — Recall, and autopilot that drafts real replies (release 0.13)

**Search.** A local inverted index (pure JS, BM25; no new runtime dependency —
engines floor is Node 20, so no `node:sqlite`) over memory notes and over
(prompt, final answer) turns from both assistants. Incremental by transcript
mtime, stored 0600. `gradient recall "<query>"`, used by the skills.

**Autopilot `reply` mode** (replaces the unreachable `full` mode):

1. On Stop, the judge decides: done · stopped early · waiting on a routine
   question · waiting on a real decision. Default is stand down; "stopped
   early" requires the last assistant message to name unfinished work.
2. For a routine question, retrieve the 5 most similar past (assistant question
   → your reply) pairs from your history; Haiku drafts the reply in your words.
3. **Hard gate, not model judgment:** if the question or the draft mentions an
   irreversible action — push, deploy, release, publish, merge, delete/rm,
   drop, migrate production, send/email/post, pay/charge/spend, rotate keys,
   or anything the `gradient.md` Rules name — autopilot stands down.
4. The reply is labelled as Gradient's, not yours: "Automated reply from
   Gradient autopilot. It does not authorize pushes, deploys, merges,
   releases, deletions, messages or spending — ask the user."
   Claude Code's own permission mode still applies underneath.
5. Budgets: ≤ 3 drafted replies per session, the existing no-progress latch,
   every reply logged and listed in the `gradient` report.
6. **Ship gate:** a labelled set from your own history (each stop's label is
   your actual next message) plus today's 5 logged decisions. `reply` ships
   only at ≥ 90 % precision on "continue / reply"; `nudge` must stop producing
   today's 2-of-2 false nudges.

### Later — other harnesses and hosting

- `gradient mcp`: `recall` and `remember` tools for Cursor and other MCP hosts.
- Hosted sync of the small notes layer only (never transcripts), opt-in,
  redacted; or a Lore/Notion adapter instead of a Gradient server.

## 6. Measuring

- Repeated corrections per repo per week (already mined) — the primary metric:
  if memory works, you stop repeating yourself.
- Injected bytes per session, per assistant; unreachable-note count.
- Autopilot: nudge/reply precision (your next message did not countermand it).
- Report retrieval quality and formation transfer separately, as Lore does.
  Its pipeline's end-to-end gain was not significant. So memory counts as
  working only when the primary metric moves, not when notes accumulate.

## 7. Code removed or replaced

- Continuity's `progress.md` checkpoint and recap (`commands/checkpoint.ts`,
  `commands/recap.ts`, `progressPath`): replaced by the memory index on
  compact/resume. It records hook text such as "Stop hook feedback: Continue."
  as your intent, and its activity line is a tool count. Consent migrates from
  `continuityProjects`.
- The playbook's mined section (`core/playbook.ts` `MINED_START`/`MINED_END`,
  `renderMinedSection`): mined habits become memory notes. The Rules section
  stays — it is autopilot's safety clamp.
- `AutopilotMode` `"full"` (`core/types.ts`, `config.ts`): replaced by `"reply"`.

## 8. Risks and open questions

- Claude Code's auto-memory layout and load limits, and Codex's hook and
  memories contracts, are external. Re-read the official docs at
  implementation; third-party sources informed parts of this draft.
- Moving notes between stores touches your data: archive-only, restore point,
  approval per change.
- Transcripts hold secrets: notes pass `redact()`; nothing leaves the machine
  before the opt-in sync, and that sync never carries transcripts.
- Stored text is a prompt-injection channel: untrusted framing on every read;
  autopilot never treats a note as authority.
- 40 concurrent sessions: all writes under `withLock`; sessions only append
  candidates to per-session inbox files.

## 9. Review notes

Reviewed as a principal engineer after the first draft; changes made:

- Moved the hosted store from the first phase to "Later". Notion shipped it on
  11-04, and local-first is the advantage.
- Put **Tidy** (Phase 1) ahead of **Learn**: it addresses the measured problem
  (683 unreachable notes, 473 stale-status notes) with no new trust surface.
- Kept the runner model-free: duplicates by shingle similarity, not an LLM;
  the only model call outside autopilot is the opt-in contradiction judge.
- Replaced the industry/category taxonomy with two scopes plus optional tags,
  following the article's finding that fixed rules hurt strong models.
- Keyed repo scope by git common directory, the root cause shared with
  today's worktree bugs.
- Added a measured ship gate for autopilot `reply`, and a deterministic
  irreversible-action gate instead of trusting the judge.
- Added the dead-code removals in §7.
- After reading Lore's pipeline and evaluations, dropped a background
  "autosave" model run from Phase 2. It is costly, it has an unrestricted-tools
  failure mode, and Lore measured no significant end-to-end gain from it. I
  also made index entries pointers rather than bodies.
- Dropped a dedicated `gradient memory` verb: findings ride `optimize`,
  reading rides the report and `recall`, so the surface stays at five verbs.
