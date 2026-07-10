# gradient CLI

The local-first `gradient` command-line tool.

```bash
npx gradient.md init      # configure (reuses your `claude` auth — no API key needed)
npx gradient.md scan      # read-only: find repeated prompts, error pastes, and answers
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
2. Clusters repeated prompts, failing-command pastes, and short Q→A preferences
   locally (no LLM) into candidate patterns. Pasted bodies are discarded.
3. Sends only the top candidates to an LLM (the `claude` CLI by default, with an
   Anthropic API-key fallback) to name and type them.
4. You approve; it writes `.claude/skills/<name>/SKILL.md` and project rules
   under `.claude/rules/`, prints `/loop` or user-rule instructions, or proposes
   `settings.json` hooks that call `gradient` subcommands.

Skills are the default because Claude Code can invoke them from their mined
trigger descriptions. Set `emitTarget` to `"command"` in the gradient config
for legacy `.claude/commands/*.md` output. `gradient migrate --dry-run` previews
conversion of manifest-tracked commands; `gradient migrate` performs it without
touching hand-written files.

`gradient recall on` installs an LLM-free `UserPromptSubmit` hook. Its local
index covers project and user-level commands and skills; its adoption log stores
only artifact names and match scores, never prompt text. `gradient stats` shows
uses, last use, retypes caught, and stale-artifact removal suggestions.

`gradient insights [--user] [--html]` is also LLM-free. It counts behavior
signals such as nudges, interrupts, compacts, error pastes, and model churn,
then routes them to concrete gradient actions. `gradient continuity on`
installs the paired, reversible checkpoint/recap hooks that preserve a redacted
`progress.md` across compaction and resumed sessions.

Nothing is written until you approve it in `review`, and everything written is
tracked in `.gradient/manifest.json` so `remove` cleanly undoes it.

## Autopilot (opt-in)

`gradient autopilot` installs a `Stop` hook that answers the nudges you type most
(`continue`, `what's next?`) using the phrasings mined into your `gradient.md`.

```bash
npx gradient.md autopilot nudge    # opt in: push unfinished work forward
npx gradient.md autopilot status   # what did it do while I was away?
npx gradient.md autopilot off      # remove the hook
```

It is bounded by a per-session budget, latches off when it sees no progress, and
fails open — any error means the stop simply stands. The judge runs with every
tool denied, so it can only decide, never act. A committed `gradient.md` at a
repo root can lower autopilot's authority for everyone, never raise it.

## Usage and billing

gradient calls Claude by spawning `claude -p`, which draws on the **Agent SDK
credit** included with a Pro or Max plan — a separate allowance from interactive
Claude Code usage. `scan` costs one call per run; `autopilot` costs one call per
stop, so leaving it on is a recurring cost. For CI or anything shared, set
`ANTHROPIC_API_KEY` and pin `"backend": "anthropic"` in your config.

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
