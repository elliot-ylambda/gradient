# gradient CLI

The local-first `gradient` command-line tool.

```bash
npx gradient.md init      # configure (reuses your `claude` auth — no API key needed)
npx gradient.md scan      # mine history; send bounded candidates to the configured model
npx gradient.md review    # approve the ones you want; gradient writes the artifacts
npx gradient.md list      # see what it generated · npx gradient.md remove <name> to undo
npx gradient.md migrate   # convert older generated commands into skills
npx gradient.md recall on # hint when prompts match installed artifacts
npx gradient.md stats     # coverage and artifact adoption
```

## How it works

1. Reads your Claude Code transcripts (`~/.claude/projects/**/*.jsonl`).
2. Clusters repeated prompts locally (no LLM) into candidate patterns.
3. Sends only the top candidates to an LLM (the `claude` CLI by default, with an
   Anthropic API-key fallback) to name and type them.
4. You inspect the exact rendered artifact and approve; it writes
   `.claude/skills/<name>/SKILL.md`, prints `/loop` lines, or proposes hook
   settings that call allowlisted `gradient` subcommands.

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

Candidate snippets and autopilot tails are sent to the selected model after
common credential redaction. Redaction cannot identify every kind of sensitive
or proprietary text. See the repository's
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
