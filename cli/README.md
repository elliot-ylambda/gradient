# gradient CLI

The `gradient` command-line tool — the v1 **analysis engine**.

```bash
npx gradient.md init      # configure (reuses your `claude` auth — no API key needed)
npx gradient.md scan      # read-only: find repeated workflows in your history
npx gradient.md review    # approve the ones you want; gradient writes the artifacts
npx gradient.md list      # see what it generated · npx gradient.md remove <name> to undo
```

## How it works

1. Reads your Claude Code transcripts (`~/.claude/projects/**/*.jsonl`).
2. Clusters repeated prompts locally (no LLM) into candidate patterns.
3. Sends only the top candidates to an LLM (the `claude` CLI by default, with an
   Anthropic API-key fallback) to name and type them.
4. You approve; it writes `.claude/commands/*.md`, prints `/loop` lines, or proposes
   `settings.json` hooks that call `gradient` subcommands.

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

This package is built test-first per the plan in
[`docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md`](https://github.com/elliot-ylambda/gradient/blob/main/docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md).
All source paths in that plan are relative to this `cli/` directory.

```bash
npm install
npm test         # vitest
npm run build    # tsc → dist/
```

## License

MIT © ylambda
