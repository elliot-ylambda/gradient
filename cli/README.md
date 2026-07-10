# gradient CLI

The local-first `gradient` command-line tool.

```bash
npx gradient.md init      # configure (reuses your `claude` auth — no API key needed)
npx gradient.md scan      # mine bounded prompt, paste, answer, and sequence candidates
npx gradient.md review    # approve the ones you want; gradient writes the artifacts
npx gradient.md list      # see what it generated · npx gradient.md remove <name> to undo
npx gradient.md migrate   # convert older generated commands into skills
npx gradient.md recall on # hint when prompts match installed artifacts
npx gradient.md stats     # coverage and artifact adoption
npx gradient.md insights  # local behavior report and recommended actions
npx gradient.md continuity on # preserve context across compact/resume
```

## How it works

1. Reads your Claude Code transcripts (`~/.claude/projects/**/*.jsonl`).
2. Clusters repeated prompts, failing-command pastes, recurring sequences, and
   conservative low-impact Q→A preferences locally (no LLM). Pasted bodies and
   command arguments are discarded; cross-project scans skip Q→A rules.
3. Sends only the top candidates to an LLM (the `claude` CLI by default, with an
   Anthropic API-key fallback) to name and type them.
4. You inspect the exact rendered artifact and approve; it writes
   `.claude/skills/<name>/SKILL.md` and project rules under `.claude/rules/`,
   prints `/loop` instructions, or proposes local hook settings
   that call allowlisted `gradient` subcommands.

Paste and sequence findings are advisory: prior behavior is never treated as
authorization to rerun a command or execute later workflow steps. Preference
rules require repeated support across sessions, are limited to low-impact
format/style/tool choices, and preserve confirmation for consequential actions.

Skills are the default because Claude Code can invoke them from their mined
trigger descriptions. Set `emitTarget` to `"command"` in the gradient config
for legacy `.claude/commands/*.md` output. `gradient migrate --dry-run` previews
conversion of manifest-tracked commands; `gradient migrate` performs it without
touching hand-written files.

`gradient recall on` installs an LLM-free `UserPromptSubmit` hook in
`.claude/settings.local.json`. Its private user-cache index covers project and
user-level commands and skills; its adoption log stores
only artifact names and match scores, never prompt text. `gradient stats` shows
uses, last use, retypes caught, and stale-artifact removal suggestions.

`scan` writes a private per-project user cache, but it does not install Claude
artifacts or update the autopilot playbook. Approved artifacts are tracked in
`.gradient/manifest.json` so `remove` cleanly undoes them.

`gradient insights [--user] [--html]` is also LLM-free. It counts behavior
signals such as nudges, interrupts, compacts, error pastes, and model churn,
then routes them to concrete gradient actions. `gradient continuity on`
records private per-project consent and installs paired checkpoint/recap hooks;
the bounded, best-effort-redacted user-intent checkpoint lives in the private
user cache, not the repo, and returns to Claude as explicitly untrusted context.
Raw assistant/tool-output prose is excluded, and `continuity off` deletes it.
`--html` explicitly writes a private `.gradient/insights.html` report.

## Autopilot (opt-in)

`gradient autopilot` installs a `Stop` hook that answers the nudges you type most
(`continue`, `what's next?`) with the fixed non-authorizing nudge `Continue.`.

```bash
npx gradient.md autopilot nudge    # opt in: push unfinished work forward
npx gradient.md autopilot status   # what did it do while I was away?
npx gradient.md autopilot off      # remove the hook
```

It is consented per project, bounded by paid judge attempts, latches off when it
sees no progress, and fails open — any error means the stop simply stands. The
judge runs in safe mode with tools and customizations disabled; its text is never
relayed. `full` mode is disabled in `0.1.1`. A committed `gradient.md` can only
lower mode or budget through structured frontmatter; repository prose is ignored.

## Usage and billing

gradient calls Claude by spawning `claude -p`, which draws on the **Agent SDK
credit** included with a Pro or Max plan — a separate allowance from interactive
Claude Code usage. `scan` costs one call per run; `autopilot` can call once per
stop up to its attempt budget. For CI or anything shared, set
`ANTHROPIC_API_KEY` and pin `"backend": "anthropic"`; an unavailable pinned
backend fails closed rather than silently falling back.

Candidate snippets (including bounded assistant question text for project-only
preference mining) and autopilot tails are sent to the selected model after
common credential/PII redaction. Redaction cannot identify every kind of
sensitive or proprietary text. See the repository's
[security and data-boundary documentation](https://github.com/elliot-ylambda/gradient#data-and-trust-boundaries).

Full details: [Usage and billing](https://github.com/elliot-ylambda/gradient#usage-and-billing).

## Development

This package is built test-first. The current skills-output work is specified in
the [v2 funnel design](https://github.com/elliot-ylambda/gradient/blob/main/docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md)
and [Phase A plan](https://github.com/elliot-ylambda/gradient/blob/main/docs/superpowers/plans/2026-07-06-gradient-v2-phase-a-input-skills.md).

```bash
npm install
npm test         # vitest
npm run build    # tsc → dist/
```

## License

MIT © ylambda
