# gradient CLI

The local-first `gradient` command-line tool.

```bash
npx gradient init      # configure (reuses your `claude` auth — no API key needed)
npx gradient scan      # read-only: find repeated workflows in your history
npx gradient review    # approve the ones you want; gradient writes the artifacts
npx gradient list      # see what it generated · npx gradient remove <name> to undo
npx gradient migrate   # convert older generated commands into skills
```

## How it works

1. Reads your Claude Code transcripts (`~/.claude/projects/**/*.jsonl`).
2. Clusters repeated prompts locally (no LLM) into candidate patterns.
3. Sends only the top candidates to an LLM (the `claude` CLI by default, with an
   Anthropic API-key fallback) to name and type them.
4. You approve; it writes `.claude/skills/<name>/SKILL.md`, prints `/loop`
   lines, or proposes `settings.json` hooks that call `gradient` subcommands.

Skills are the default because Claude Code can invoke them from their mined
trigger descriptions. Set `emitTarget` to `"command"` in the gradient config
for legacy `.claude/commands/*.md` output. `gradient migrate --dry-run` previews
conversion of manifest-tracked commands; `gradient migrate` performs it without
touching hand-written files.

Nothing is written until you approve it in `review`, and everything written is
tracked in `.gradient/manifest.json` so `remove` cleanly undoes it.

## Development

This package is built test-first. The current skills-output work is specified in
the [v2 funnel design](../docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md)
and [Phase A plan](../docs/superpowers/plans/2026-07-06-gradient-v2-phase-a-input-skills.md).

```bash
npm install
npm test         # vitest
npm run build    # tsc → dist/
```
