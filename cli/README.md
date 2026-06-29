# gradient · cli

The command-line analysis engine. Reads your Claude Code history, finds what you
repeat, and generates the automations to stop — **slash commands, hooks, and
loops** — each one reviewed and approved by you.

```bash
npx gradient scan           # read history, cluster repeats, propose automations (read-only)
npx gradient review         # inspect the ranked suggestions and their evidence
npx gradient apply <id>     # generate an approved artifact
npx gradient list           # see what gradient has generated
npx gradient remove <name>  # clean, reversible uninstall
```

## Status

This is the **v1 analysis-engine scaffold**. It implements the full read-only
pipeline end to end:

`collect → parse → filter → cluster → detect (no-LLM) → suggestions.json`

so `gradient scan` already produces real suggestions from your own history
without any API key. The LLM-assisted `detect` refinement and the interactive
`review` flow are wired against the interfaces here and land per the
[implementation plan](../docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md).
All source paths in that plan are relative to this `cli/` directory.

## Architecture

A pure-functional core wrapped by a thin CLI, with a pluggable LLM backend.

```
src/
  cli.ts            arg parse + dispatch
  ui.ts             zero-dep terminal styling (the brand gradient in ANSI)
  types.ts          Turn / Candidate / Suggestion data model
  commands/         one file per verb (scan, review, apply, list, remove, init, checkpoint)
  core/
    collect parse filter cluster detect   the scan pipeline
    emit/ command loop hook               Suggestion → artifact
    manifest validate security            tracking + guardrails
  llm/
    backend  claudeCli  anthropic  index  pluggable model backends
skill/SKILL.md      the /gradient skill installed by `init`
tests/              unit specs over the pure core
```

## Develop

```bash
npm install
npm run typecheck
npm test
npm run build      # → dist/cli.js (executable, shebang banner)
node dist/cli.js --help
```

## Privacy

Clustering is local and LLM-free. Only short candidate snippets ever reach a
model — never whole transcripts — and a redaction pass strips secrets first. The
default backend reuses your existing `claude` CLI auth; no API key required.

MIT © ylambda
