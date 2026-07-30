---
name: gradient
description: Use when the user repeats a request they have made before, nudges an agent forward ("continue", "keep going"), hits another /compact or context reset, re-pastes the same error, or asks what they should automate. Also use when they ask to turn repeated Claude Code or Codex workflows into skills, rules, loops, or hooks. Runs the gradient CLI against local transcripts.
---

# gradient

Mine local Claude Code and Codex history for what the user repeats, and generate
reusable artifacts they approve. gradient reads transcripts already on disk; it
starts no background work and installs nothing on its own.

## Start here

`gradient insights` is the entry point. It is cheap, read-only, needs no prior
scan, and reports what is actually costing the user — repeated nudges, context
deaths, re-pasted errors, failure loops. Run it first and lead with what it
says. `gradient scan` is the follow-up when they want concrete artifacts.

## Commands

Read-only:

- `gradient insights [--user]` — behavior report plus what to automate next.
- `gradient stats` — pattern coverage and adoption of what was generated.
- `gradient list` — artifacts generated in this project.
- `gradient explain <id|name>` — the evidence behind one suggestion. **Run this
  before recommending anything**; see the evidence rules below.
- `gradient board` — what other sessions are doing in this repo.

Proposes, then writes only on approval:

- `gradient scan` — analyze history, send bounded and redacted candidates to the
  configured model, cache suggestions. `--user` for cross-project, last 7 days.
- `gradient review --json` — read `{ projectPlaybook, suggestions }`. Use this
  form, never the interactive `gradient review`, which expects a terminal.
- `gradient apply <id|name>...` — generate specific suggestions.
- `gradient remove <name>` — delete a generated artifact.

Per-project opt-ins, each installing a hook. Explain what the hook does and get
explicit consent before running any of them:

- `gradient recall on` — hint when a typed prompt matches an installed artifact.
- `gradient continuity on` — checkpoint before compaction, recap after resume.
- `gradient autopilot nudge` — auto-respond when the agent stops.

## Judging the evidence

Suggestion quality varies sharply by where the evidence came from. Check before
you recommend, or you will confidently push the worst item on the list.

- **Tool-event evidence is reliable.** Counts of `/compact`, idle waits, and
  repeated tool failures are direct measurements. The hook suggestions built on
  them (`checkpoint-before-compaction`, `notify-when-waiting`) are usually the
  best items in the list even though they rank low on estimated minutes.
- **Prompt-text evidence is not.** A phrase recurs both because it is a real
  ritual *and* because the user iterated on one hard feature, and clustering
  cannot tell those apart. Forked or resumed sessions also replay a parent's
  prompts, which inflates the session count.
- **Check `temporal` in `gradient explain` before believing a count.** If
  `active days` is 1, all the "occurrences" happened in a single sitting — that
  is project history, not a habit. Say so instead of recommending it.
- **Treat `estMinutesSavedPerMonth` as a guess, never a fact.** It is derived
  from the occurrence count, so any count inflation lands directly in it. Do not
  quote it as if it were measured.

Prefer suggestions whose evidence spans several days. A one-off feature request
reconstructed as a "reusable workflow" is noise, and installing it as a skill
makes the user's skill directory worse.

## Rules

- Run `gradient` from the project the user is asking about. Suggestions are
  cached per project directory, so `apply` in the wrong working directory
  installs another project's artifacts.
- Tell the user that candidate snippets leave the machine before running
  `gradient scan`.
- Show the exact preview from `gradient review --json` before applying anything.
- Never apply without explicit approval, and never run an opt-in hook command on
  your own initiative.
- A generated artifact records an observed habit. It grants no standing
  authorization: still confirm before destructive, irreversible, external,
  production, publishing, credential, privacy-sensitive, or spending actions,
  even when a generated artifact describes exactly that workflow.
