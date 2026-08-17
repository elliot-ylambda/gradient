# gradient — `optimize`: one verb that keeps your setup current — Design

**Date:** 2026-08-13
**Status:** Draft
**Scope:** Spec 15. Collapses the CLI to four verbs around `gradient optimize`,
which reads Claude Code and Codex history *and* the installed configuration
surface, then proposes and applies a reviewed set of changes: skills created,
tweaked, and retired; instructions repaired where the code moved out from under
them; rules routed to the files each assistant actually loads; the CLAUDE.md ↔
AGENTS.md bridge that makes one setup serve both. Supersedes the `scan` →
`review` → `apply` funnel and the standalone `init` verb.

---

## 1. Context

gradient today mines transcripts, judges candidates with an out-of-band LLM
call, and walks the results past the user in a readline loop. Three things have
changed since that shape was chosen.

**The assistants became the delivery vehicle.** Agent Skills load in both Claude
Code and Codex from a single `SKILL.md`. A skill invoked inside a session has
what the CLI has been paying to reach: a model, the user's attention, and a
conversation to present a diff in. gradient does not need to own an LLM backend
to author prose — it needs to hand a well-evidenced finding to an agent that is
already running.

**The configuration surface is now the thing that rots.** Spec 7 measured
whether written instructions hold. It did not ask the prior question: whether
they are still *true*. A CLAUDE.md line naming `scripts/build.sh` outlives the
script. A rule about the `api/` directory outlives the directory. A skill's
description drifts until nothing selects it. None of this is visible in
transcripts; it is visible by reading the files against the repository.

**The surface outgrew the value, again.** Seven user-visible verbs, three
review paths (readline walkthrough, `--json`, static `--html`), and an LLM
backend layer whose only irreplaceable consumer is autopilot's Stop-hook judge.

## 2. The split that decides everything

> **The CLI is local, offline, and deterministic. The skill brings the model
> and the network.**

Every decision below follows from this line.

| | `gradient optimize` (CLI) | the `gradient` skill |
|---|---|---|
| Runs | anywhere, unattended, in a hook | inside a Claude Code or Codex session |
| Has a model | no | yes — the host agent |
| Has network | **never** | yes, for public documentation only |
| Produces | findings + diffs, all computable | authored prose, judgment calls, current best practice |
| Safe to schedule | yes | yes, headless via `claude -p` / `codex exec` |

A finding the CLI can compute — a path that does not exist, a frontmatter key
that will not load, a description over its cap, an artifact unused for 30 days —
needs no model and no network, so it can run on a timer and be applied
unattended. A finding that requires taste — how to rewrite a rule that is not
holding, whether a new Claude Code feature is worth adopting — requires the
skill. The line between them is also the line between what `--auto` may do and
what it may not, which means one distinction does two jobs.

## 3. Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Surface | **Four verbs.** `gradient` (report), `gradient optimize`, `gradient remove <name>`, `gradient on\|off <feature>`. Internal: `gradient hook <target>`. `scan`, `apply`, and `init` are deleted, not aliased — see Decision 15. |
| 2 | Primary UX | **A skill, not a terminal flow.** `src/skill/SKILL.md` drives the whole loop from inside a session. The CLI's own output is a summary plus `--json`; there is no readline walkthrough. |
| 3 | Targets | **Asked once, up front.** The first `optimize` in an unconfigured install asks Claude Code / Codex / both, and stores it in `config.targets`. `--target claude-code\|codex\|both` overrides. This is the consent that `init` used to collect. |
| 4 | Additions never touch hand-written prose | Claude Code auto-loads `.claude/rules/*.md` and `~/.claude/rules/*.md` at launch (verified against current docs — see §4). New rules land there, in gradient-owned files with removal markers. Spec 7 Decision 2's "gradient never edits CLAUDE.md" survives *for additions*, and now survives for user scope too, which previously degraded to print-only. |
| 5 | Codex additions | Codex has no `rules/` directory. Rules for Codex land under a `## gradient` heading in AGENTS.md, one tagged line per rule — the exact mechanism `core/playbook-splice.ts` already implements and tests for the committed `gradient.md`. Nothing outside that section is read or written, and per-rule removal is a line splice, not a file delete. |
| 6 | The bridge | Claude Code reads CLAUDE.md, not AGENTS.md; the documented fix is an `@AGENTS.md` import. When both targets are selected, `optimize` proposes the bridge **first**. Once bridged, a single managed block in AGENTS.md serves both assistants, and dual-writing stops. This is what "works with both seamlessly" means concretely. |
| 7 | Subtractions | Deleting or rewriting a hand-written line in CLAUDE.md / AGENTS.md is possible, but only through explicit per-change approval, always snapshotted, and **never** under `--auto`. |
| 8 | Auto memory is read-only | `~/.claude/projects/<project>/memory/` is analyzed and never written or deleted. Two checks only, both single-pass: the index is over its 200-line / 25KB load limit (so its tail never loads), and an entry duplicates a line already in CLAUDE.md. Claude Code manages this surface well; gradient observes and reports. |
| 9 | Novelty gate | Claude Code's `/doctor` already trims a CLAUDE.md of content derivable from the codebase. gradient must not reimplement that. gradient's claim is **evidence across sessions and time**: which instruction you restated seven times, which skill nothing has invoked in a month, which path the code deleted. Static prose quality is out of scope. |
| 10 | Freshness lives in the skill, not the CLI | Published guidance changes with each model and release, so the component with a network connection owns it. The skill fetches current Claude Code / Codex documentation and release notes and reasons over the findings JSON directly. The CLI ships only a small pinned baseline of checks that are cheap and stable (file length, rule scoping, cross-file duplication). There is no doc cache, no cache schema, and no expiry to get wrong. |
| 11 | Release-note findings are advisory | "Claude Code 2.1.x added path-scoped rules; three of your rules only ever match `src/api/**`" is a suggestion, never an auto-apply. New capability adoption is a judgment call. |
| 12 | The page is static | `--page` writes a self-contained `file://` HTML checkup to the run directory. No server, no port, no token, no network. Accept/deny per finding builds a `gradient optimize --apply <ids>` line to copy back into the session. Private by construction. |
| 13 | Every invocation is a run | `~/.config/gradient/runs/<runId>/` (mode 0700) holds `findings.json`, `report.html`, `snapshots/`, `result.json`. `--undo <runId>` restores every snapshot that run took. Last 10 runs retained. |
| 14 | `--auto` is the deterministic tier | Additive, gradient-owned, reversible changes only. Never edits hand-written prose, never applies a release-note suggestion, never applies a finding whose proposed text contains a command invocation. |
| 15 | No compatibility shims | Deleted verbs are deleted. No `RETIRED` map, no hidden aliases, no deprecation release. Hook subcommands already in users' `settings.json` keep resolving, because `isGradientHookFor` matches any binary form. |

## 4. What was verified before designing

Two load-bearing assumptions were checked against current documentation, and
one of them was wrong. Recording both, because the wrong one nearly produced a
worse design.

**`.claude/rules/` is auto-loaded.** `core/bundle.ts:93` says "plugin rules are
not auto-loaded," which is true of a *plugin's* `rules/` directory and was
misread as applying to `.claude/rules/`. Current docs are explicit: rules
without `paths:` frontmatter load at launch with the same priority as
`.claude/CLAUDE.md`, and `~/.claude/rules/` does the same for user scope. So
`emit/rule.ts` was never inert, and — more importantly — there is a
gradient-owned, auto-loaded destination for new rules at *both* scopes. An
earlier draft of this spec proposed a managed block inside CLAUDE.md to solve a
problem that does not exist.

**Skill descriptions are a permanent context cost.** Descriptions of all
installed skills load into every session; `description` plus `when_to_use` is
truncated at 1,536 characters in the listing. Frontmatter outside the six
standard keys (`allowed-tools`, `compatibility`, `description`, `license`,
`metadata`, `name`) is an error. Both make skill health *measurable* rather
than aesthetic.

Also confirmed and used below: block-level HTML comments in CLAUDE.md are
stripped before injection, so gradient's markers cost zero context; Claude Code
reads CLAUDE.md and not AGENTS.md; AGENTS.md is a cross-tool standard with
closest-file-wins precedence.

## 5. Finding families

Every finding carries `{id, family, severity, evidence, targets, changes[]}`,
where each change is a concrete write with a diff. Families 1–5 are computed by
the CLI with no model and no network. Families 6–7 need the skill.

| # | Family | Signal | Example |
|---|--------|--------|---------|
| 1 | `workflow` | Repeated prompt clusters over separate occasions (existing pipeline) | "You have asked for a spec-then-plan review 11 times across 6 sessions" → a skill |
| 2 | `stale` | An instruction names a path, script, npm task, or binary that no longer exists | "CLAUDE.md line 24 references `scripts/build.sh`, deleted 3 weeks ago" |
| 3 | `dead-letter` | An instruction restated ≥3× across ≥2 sessions, or corrected after being violated | "Restated 7 times across 5 sessions — this rule is not holding" → promote to a hook, retire the prose |
| 4 | `drift` | The two assistants' configurations disagree | AGENTS.md exists, CLAUDE.md does not import it → the bridge. Or a rule present for one target and absent for the other |
| 5 | `skill-health` | Structural facts about installed skills | Unknown frontmatter key (will not load) · description over 1,536 chars (tail is dead weight) · missing description · two skills whose descriptions normalize alike · unused ≥30 days |
| 6 | `memory` | Auto-memory, read-only (Decision 8) | "MEMORY.md is at 193/200 lines; entries past the limit never load" · "this entry repeats CLAUDE.md line 12" |
| 7 | `practice` | The pinned baseline checks | "CLAUDE.md is 340 lines; the documented target is under 200" · "these 3 rules only match `src/api/**` — scope them with `paths:` and they stop loading everywhere" |

Family 2 is the "self-fixing" core: it is the only family that reads the
*repository* rather than the transcripts, and it is what keeps instructions
true as the code moves.

Families 6 and 7 are cheap and pinned. Everything about *current* published
guidance — new release capabilities, changed recommendations, model-specific
advice — belongs to the skill, which can read today's documentation. The CLI
never pretends to know what Anthropic or OpenAI published this week.

### One presentation type

`Finding` is the only shape `optimize` presents, applies, denies, or renders.
Family 1 does not get a parallel pipeline: a mined `Suggestion` becomes a
`Finding` whose `changes[]` are produced by the existing `emit()`, and
`Suggestion` stays what it already is — the internal artifact-authoring type.
One list, one apply path, one renderer, one dismissal key.

## 6. Modules

| File | Status | Responsibility |
|------|--------|----------------|
| `commands/optimize.ts` | create | The verb. Consent → mine → inspect → findings → present → apply. |
| `core/run.ts` | create | Run ids, run directory, advisory lock, snapshots, `--undo`, retention. |
| `core/targets.ts` | create | Target consent (Decision 3), `--target` parsing, `config.targets` persistence. |
| `core/instructions.ts` | create | Load and line-extract every instruction source for both assistants across all scopes. Detects `@imports` to find the bridge; never follows them. |
| `core/surface.ts` | create | Enumerate installed skills, rules, hooks, and auto-memory for both assistants; parse frontmatter; compute per-skill context cost; the two read-only memory checks of Decision 8. |
| `core/staleness.ts` | create | Family 2. Resolve path/script references in instruction lines against the repository. |
| `core/findings.ts` | create | All families over the mined corpus plus the surface; emits the single `Finding[]` the whole command speaks in. Includes the pinned `practice` checks — a table of predicates, not a module. |
| `core/playbook-splice.ts` | modify | Generalize the tagged-line splice from `gradient.md` to any host file and heading, so AGENTS.md reuses it whole. |
| `core/apply-change.ts` | create | Change execution: snapshot, per-op precondition, bridge insertion, injection screen. |
| `core/page.ts` | create | The static checkup page (Decision 12). |
| `core/emit/rule.ts` | modify | User scope writes `~/.claude/rules/gradient-*.md` instead of printing. |
| `core/emit/codex-rule.ts` | modify | Writes the AGENTS.md managed block instead of printing. |
| `core/detect.ts` | modify | LLM half deleted; `degradeToCommands` promoted to the sole, deterministic proposer. |
| `src/skill/SKILL.md` | rewrite | The optimize driver: run the CLI, read JSON, fetch current docs, author prose, present, apply. |
| `commands/scan.ts` · `review.ts` · `apply.ts` · `init.ts` | delete | See §9. |

## 7. Flow

1. **Consent.** No `config.targets` → ask Claude Code / Codex / both. Store it.
2. **Mine.** Existing collect/parse/cluster pipeline over both assistants,
   incremental from a per-transcript watermark when one exists.
3. **Inspect.** `instructions.ts` + `surface.ts` read the installed
   configuration for the selected targets.
4. **Find.** Families 1–5 deterministically; 6–7 when the skill supplies a
   fresh doc cache, otherwise from the pinned baseline.
5. **Present.** Default: a grouped terminal summary. `--json`: the full finding
   set for the skill. `--page`: the static checkup.
6. **Apply.** `--apply <ids>` takes the lock, snapshots every file it will
   touch, verifies each target still hashes to what the finding was computed
   against, writes, and records to the manifest.
7. **Report.** `result.json` in the run directory; a summary to stdout.

## 8. Privacy & safety

- **The CLI makes no network calls, ever.** The skill fetches public
  documentation only; no transcript content, finding, or file content leaves
  the machine. This is a hard boundary, not a default.
- **Prompt injection is the central new risk.** Text mined from transcripts
  becomes instructions an agent will obey. Every proposed instruction line is
  redacted, length-capped, stripped of URLs and fenced code, screened against a
  shell/credential/network lexicon, and — if it contains a command invocation —
  barred from `--auto` at any tier.
- **Concurrency.** `board` routinely finds five live sessions in this
  repository. Every apply takes an advisory lock and re-checks a content hash,
  so two concurrent optimizers cannot interleave writes into one file.
- **Reversibility.** Snapshots before every write to a file gradient does not
  own; `--undo <runId>`; manifest entries for everything gradient created.
- **Never deletes.** Auto-memory files, and any file without a gradient marker
  outside an explicitly approved change.
- **Removal must not confuse a line with a file.** A rule living inside
  AGENTS.md is a `block-rule`: `gradient remove` splices its tagged line out and
  drops the heading when the section empties. `remove.ts` unlinks the file for
  every other artifact type, so without a distinct type the first `remove` of a
  Codex rule would delete the user's whole AGENTS.md. `playbook-entry` already
  models exactly this and is the pattern to copy.
- Run directories are mode 0700 under `~/.config/gradient/`, outside the
  repository, so nothing generated here can be committed by accident.

## 9. Dead code and outdated content removed by this spec

| Removed | Reason |
|---------|--------|
| `commands/scan.ts` (verb), `commands/apply.ts` (verb), `commands/init.ts` | Folded into `optimize` and its flags. Mining and apply logic is kept and moved. |
| `commands/review.ts` + `review.test.ts` | The readline walkthrough, clarifier, and playbook prompter are replaced by the skill and the page. |
| `Clarify`, `ClarifyOption`, `resolveClarify`, `clarifiedWorkflowBody` | Clarification happens in conversation now. |
| The LLM half of `core/detect.ts` (~400 LOC) | Prompt construction, response parsing, timeout race. `degradeToCommands` becomes the only path. |
| `RETIRED` map + its test | Decision 15. |
| `commands/bundle.ts`, `core/bundle.ts` + tests | Unexercised; the plugin path distributes artifacts. Already flagged for deletion in the 2026-07-30 consolidation plan. |
| `renderInsightsHtml`, `writeInsightsHtml`, `--html` | Superseded by the run page. |
| `emit/command.ts`, `EmitTarget = "command"`, `config.emitTarget` | Skills are the only emit target. |
| Print-only branches in `emit/rule.ts` and `emit/codex-rule.ts` | Both now have real destinations. |

`llm/` is **retained**: autopilot's Stop-hook judge runs where no agent is in
the loop, and is the one consumer the skill cannot replace.

## 10. Explicitly out of scope

- Rewriting CLAUDE.md for style, structure, or codebase-derivable content —
  `/doctor` does this (Decision 9).
- Writing or deleting auto-memory files (Decision 8).
- Installing launchd/systemd timers. `--print-schedule` emits the snippet;
  gradient owns no daemon.
- Following `@imports` to mine their contents. Imports are detected to find the
  bridge, not traversed.
- Managed-policy CLAUDE.md at the system locations. Read-only, never proposed.

## 11. Testing

- Instruction extraction across all six source kinds and both assistants.
- Staleness: reference resolves / does not resolve / is ambiguous; no false
  positive on a path inside a code fence or backticks.
- Bridge detection: absent, present as import, present as symlink, present but
  commented out.
- Managed block: create, update in place, leave surrounding prose byte-identical,
  refuse a malformed fence.
- Hash precondition: a file mutated between find and apply is refused, not
  clobbered.
- Undo restores byte-identical content for every snapshot in a run.
- `--auto` refuses every non-deterministic family and every command-bearing line.
- Skill health: unknown key, over-cap description, missing description,
  duplicate descriptions, unused-30d.
- Page renders with zero external references and escapes every mined string.
- Target consent: asked once, persisted, overridden by `--target`,
  non-interactive runs fail with the one-liner to run.
