# gradient

Turn the things you repeat in Claude Code into slash commands, loops, and hooks.

`gradient` reads your own Claude Code history, learns the workflows you repeat,
and helps you automate them — through a read-only **scan** → approve **review** →
reversible **apply** flow.

## Monorepo layout

| Dir | What it is |
|-----|------------|
| [`cli/`](cli/) | The `gradient` CLI — the v1 analysis engine (TypeScript / npx). In active development. |
| [`webapp/`](webapp/) | Next.js web surface (landing / future dashboard). |
| [`docs/`](docs/) | Design spec and implementation plan. |

## Status

v1 is the **offline analysis engine**: it mines transcripts and proposes
slash-command / loop / hook artifacts you approve. A live "autopilot" loop
(an LLM-driven `Stop` hook that auto-continues until a task is actually done)
is planned as phase 2.

- Design spec: [`docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md`](docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md`](docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md)

## License

MIT
