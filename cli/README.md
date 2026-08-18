# gradient CLI

The local-first engine behind the gradient skills. This directory is source, not
a package: it is **published nowhere**, and is built into the single-file runner
that both shipping shapes carry — the Claude Code plugin, and the three skill
directories Codex's `$skill-installer` puts in `~/.codex/skills`. See the
[root README](../README.md) for how to install either.

That is the whole distribution story. There is no npm package, no `npx`, and
nothing on your PATH: a skill directory carries its own runner, so it keeps
working with no network, no cache that can be evicted, and no global install to
keep current.

```bash
# `G` is the runner the installed skill names — bin/gradient.mjs inside the
# plugin, or ~/.codex/skills/gradient-optimize/bin/gradient.mjs.
node $G optimize      # find what recurs and what has gone stale, then propose
node $G               # the report: what it cost, what is installed, what else is running
node $G remove <name> # uninstall a generated artifact
node $G on optimize   # re-check after a session ends, at most once a day
```

Normally you do not type these at all — you ask your assistant to optimize your
setup, and the skill runs them. Hooks gradient installs name the same runner by
absolute path, which is why turning a feature on needs no PATH entry either.

## The CLI makes no network calls

Not "by default" — at all. It calls no model and stores no API key. Everything
it reports is either counted from your local transcripts or read out of your own
configuration files, and everything it proposes is checkable:

- a path, script, or make target an instruction names that the repository no
  longer has
- a skill frontmatter key outside the Agent Skills spec, a missing description,
  or one past the 1,536-character listing cap
- an artifact installed thirty days ago that nothing has ever invoked
- a phrase you typed nine times across five sessions that your CLAUDE.md
  already contains

Judgment — rewriting a rule that is not holding, deciding whether today's
published guidance still says what gradient thinks — belongs to the bundled
`gradient` skill, which runs inside Claude Code or Codex and has both a model
and a network. `gradient optimize --json` is the interface between them.

## How a run works

1. **Consent.** The first run asks which assistants to optimize for and
   remembers the answer. `--target claude-code|codex|both` overrides it. A
   non-interactive run with nothing configured fails with the flag to pass
   rather than guessing.
2. **Mine.** Reads enabled local histories — Claude Code
   (`~/.claude/projects/**/*.jsonl`) and Codex (`~/.codex/sessions/**/*.jsonl`),
   excluding spawned subagent logs. The Claude pass also pairs Bash calls with
   their results and notes Edit/Write/NotebookEdit events using bounded reads.
   Clusters repeated prompts, failing-command pastes, recurring sequences, and
   conservative low-impact Q→A preferences. Tool candidates retain only bounded
   command heads and redacted first error lines — never successful output or
   file contents.
3. **Inspect.** Reads the instruction files each assistant actually loads
   (`CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/**`,
   `~/.claude/CLAUDE.md`, `~/.claude/rules/**`, `AGENTS.md`,
   `~/.codex/AGENTS.md`), every installed skill for both assistants, and — read
   only, never written — the auto-memory index.
4. **Find.** Turns all of it into one ranked list of findings, each with a
   quotable evidence line and the exact change it would make.
5. **Apply.** `--apply <id>...` writes only what you named, under an advisory
   lock, snapshotting every file gradient does not own and refusing any change
   whose file moved since the finding was computed.

`--apply` deliberately does not re-mine: it is a follow-up to a run you are
already looking at, and rebuilding findings from hundreds of transcripts would
make approving a one-line change the slowest thing gradient does.

## Turning findings into artifacts

Approval writes `.claude/skills/<name>/SKILL.md`, portable Codex skills under
`.agents/skills/<name>/SKILL.md`, and project rules under
`.claude/rules/gradient-<name>.md` — which Claude Code auto-loads at launch with
the same priority as `.claude/CLAUDE.md`. Codex has no rules directory, so a
rule for Codex becomes one tagged line under gradient's own `## gradient`
heading in `AGENTS.md`; removal splices that line out and drops the heading when
it empties, never touching the rest of the file.

Suggestion ids derive from source evidence rather than a generated name, so
renaming an artifact never changes its identity. Skips persist in the
human-editable `.gradient/dismissed.json` and resurface only when a later run
adds genuinely new evidence.

Paste and sequence findings are advisory: prior behavior is never treated as
authorization to rerun a command or execute later workflow steps. Preference
rules require repeated support across sessions, are limited to low-impact
format/style/tool choices, and preserve confirmation for consequential actions.
A detected post-edit ritual becomes a `PostToolUse` hook only after you see the
exact command and approve its automatic execution. Set `"mineToolEvents": false`
in `~/.config/gradient/config.json` to disable tool-event extraction entirely.

## Reviewing

```bash
gradient optimize --json    # the full finding set, for an agent to drive
gradient optimize           # every run also writes a self-contained local page
```

The page is a `file://` document with no server, no port, and no external
reference of any kind — no stylesheet, script, font, or image — so it renders
identically offline and cannot report what it is displaying. Accept or deny each
finding and it builds the `gradient optimize --apply …` line to copy back.

## Headless and scheduled

```bash
gradient optimize --auto             # additive, reversible, gradient-owned changes only
gradient on optimize                 # SessionEnd re-check (≤ daily) + SessionStart surface
gradient optimize --print-schedule   # a cron/launchd/schtasks snippet for this platform
```

`--auto` never edits prose a person wrote, never installs a new artifact, and
never applies a line whose text carries a command invocation. gradient installs
no daemon and owns no timer; `--print-schedule` prints the snippet and leaves
installing — and removing — it to you.

## Undo

Every run that writes gets an id. Every write to a file gradient does not own is
snapshotted first.

```bash
gradient optimize --undo 20260813-221000-abc123
```

A file that changed *again* after the run is reported rather than restored:
undo must never be the thing that loses work.

## Autopilot (opt-in)

`gradient on autopilot` installs a `Stop` hook that answers the nudges you type
most (`continue`, `what's next?`) with the fixed non-authorizing nudge
`Continue.`. It is the one feature that still calls a model.

It is consented per project, bounded by paid judge attempts (default 10,
absolute ceiling 100), latches off when it sees no progress, and fails open —
any error means the stop simply stands. The judge runs in safe mode with tools
and customizations disabled; its text is never relayed. A committed
`gradient.md` can only lower mode or budget through structured frontmatter;
repository prose is ignored. `gradient` (the bare report) shows its mode,
budget, clamps, and recent decisions while it is on.

## Model use and billing

The optimize path costs nothing: no model call, no API key, no network. Only
autopilot's Stop-hook judge calls a model, using `claude -p` or an isolated
`codex exec --ephemeral` under your existing CLI login, and only when you have
turned it on for that project. For CI or anything shared, set
`ANTHROPIC_API_KEY` and pin `"backend": "anthropic"`; an unavailable pinned
backend fails closed rather than silently falling back.

See the repository's
[security and data-boundary documentation](https://github.com/elliot-ylambda/gradient#data-and-trust-boundaries).

## Development

```bash
npm install
npm test         # vitest
npm run build    # tsc → dist/
npm run dogfood  # packed offline install → 18 end-to-end scenario groups
```

`GRADIENT_HOME=/absolute/path` is an optional isolation override for CI,
portable test environments, and dogfooding. It redirects gradient's config,
state, installed-skill, and assistant-history roots without changing the
process's system home.

`npm run dogfood -- --output ../artifacts/dogfood` writes `report.json`,
`report.md`, and a self-contained `report.html`. The run packs the real tarball,
installs it into a disposable consumer with an empty cache, and drives the
installed binary against invented transcripts and deterministic local backend
stand-ins — it never reads real history or spends model credits. It also asserts
that every command in `--help` has a scenario, so the surface cannot drift from
its coverage.

## Releasing

1. Bump `version` in `package.json`.
2. `npm run build:plugin` — regenerates `../plugin/bin/gradient.mjs` and syncs
   `../plugin/.claude-plugin/plugin.json`. Commit both with the bump
   (the version-sync test fails otherwise).
3. `npm run dogfood` — require a fully passing packaged report. This also runs
   from `prepublishOnly`, so a failed scenario aborts publication.

## License

MIT © ylambda
