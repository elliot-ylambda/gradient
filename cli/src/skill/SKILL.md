---
name: gradient
description: Use when the user repeats a request they have made before, nudges an agent forward ("continue", "keep going"), hits another /compact or context reset, re-pastes the same error, or asks what they should automate. Also use when they ask to turn repeated Claude Code or Codex workflows into skills, rules, loops, or hooks. Runs the gradient CLI against local transcripts.
---

# gradient

Measure how the user actually works, from Claude Code and Codex transcripts
already on disk, and automate what genuinely recurs. gradient starts no
background work and installs nothing on its own.

## Start here

Run bare `gradient`. It is cheap, read-only, needs no prior scan, and answers
every question at once: what the user's habits cost them, which generated
artifacts exist and whether they are ever invoked, what other sessions are doing
in this repo, and what to do next. Lead with what it says.

`gradient scan` is the follow-up, and only when they want concrete artifacts.

## Commands

There are six. Anything else you remember (`insights`, `stats`, `list`,
`explain`, `mirror`, `review`, `board`, `continuity`, `autopilot`, `migrate`)
is a retired alias — it still runs, but say the current form.

- `gradient` — the report. Read-only.
- `gradient scan [--json]` — analyze history, send bounded and redacted
  candidates to the configured model, then walk the proposals. **Use `--json`**;
  the interactive walkthrough expects a terminal. `--user` widens to
  cross-project, last 7 days.
- `gradient apply <id|name>...` — install specific proposals.
- `gradient remove <name>` — uninstall a generated artifact.
- `gradient on|off <feature>` — `continuity`, `autopilot`, `board`,
  `session-scan`. Each installs a hook that runs on its own afterwards: explain
  what it does and get explicit consent before running one.
- `gradient init` — first-run setup.

## Judging the evidence

Suggestion quality varies sharply by where the evidence came from, and `scan`
labels it. Check before you recommend, or you will confidently push the worst
item on the list.

- **`measured` is reliable.** These are counted tool invocations — `/compact`
  calls, idle waits, repeated command failures. The two hook suggestions built
  on them (`checkpoint-before-compaction`, `notify-when-waiting`) are almost
  always the best items in the list.
- **`possible` is an interpretation.** A phrase recurs both because it is a real
  ritual *and* because the user iterated on one hard feature for an afternoon,
  and clustering cannot tell those apart. Read the evidence before repeating the
  claim.
- **A workflow artifact that only restates the prompt is worthless.** `scan`
  drops those now, but if you are looking at an older cache, apply the same
  test: if the body is the user's sentence with a heading above it, invoking it
  costs more than typing it.
- **`estMinutesSavedPerMonth` is a guess, never a fact.** It is derived from the
  occurrence count, so any count inflation lands directly in it. It is no longer
  displayed; do not resurrect it from `--json` and quote it as measured.

Prefer suggestions whose evidence spans separate occasions. A one-off feature
request reconstructed as a "reusable workflow" is noise, and installing it makes
the user's skill directory worse.

## Rules

- Run `gradient` from the project the user is asking about. Suggestions are
  cached per project directory, so `apply` in the wrong working directory
  installs another project's artifacts.
- Tell the user that candidate snippets leave the machine before running
  `gradient scan`.
- Show the exact preview from `gradient scan --json` before applying anything.
- Never apply without explicit approval, and never turn on a background feature
  on your own initiative.
- A generated artifact records an observed habit. It grants no standing
  authorization: still confirm before destructive, irreversible, external,
  production, publishing, credential, privacy-sensitive, or spending actions,
  even when a generated artifact describes exactly that workflow.
