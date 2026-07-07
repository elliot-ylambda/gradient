# gradient CLI

The `gradient` command-line tool — the v1 **analysis engine**.

```bash
npx gradient init      # configure (reuses your `claude` auth — no API key needed)
npx gradient scan      # read-only: find repeated workflows in your history
npx gradient review    # approve the ones you want; gradient writes the artifacts
npx gradient list      # see what it generated · npx gradient remove <name> to undo
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

## Development

This package is built test-first per the plan in
[`../docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md`](../docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md).
All source paths in that plan are relative to this `cli/` directory.

```bash
npm install
npm test         # vitest
npm run build    # tsc → dist/
```

## Releasing

1. Bump `version` in `package.json`.
2. `npm run build:plugin` — regenerates `../plugin/bin/gradient.mjs` and syncs
   `../plugin/.claude-plugin/plugin.json`. Commit both with the bump
   (the version-sync test fails otherwise).
