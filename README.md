<div align="center">

# gradient

**The prompts you keep retyping into Claude Code, compiled into commands.**

`gradient` reads your own Claude Code history, finds the workflows you repeat,
and generates the automations to stop — **slash commands, loops, and hooks** —
through a read-only **scan** → approve **review** → reversible **apply** flow.
It only ever suggests: nothing runs without you.

[gradient.md](https://gradient.md) · open source · MIT

</div>

---

## Why

A dogfooding run over real history (2,800+ transcripts, ~5k typed prompts) found
the same things everyone does in Claude Code:

- `continue` / `what's next?` typed **hundreds** of times → a loop you never set up
- `/compact` run **143×** → a `PreCompact` checkpoint you keep forgetting
- "write the implementation plan", "review the spec then write the plan",
  "push and open a PR and review it" repeated every week → slash commands waiting
  to be named

`gradient` mines those patterns out of your history and hands you the artifact.

## Repository layout

```
gradient/
  cli/    →  the gradient CLI — the v1 analysis engine (TypeScript / npx)
  docs/   →  design spec and implementation plan
```

| Dir | What it is |
|-----|------------|
| [`cli/`](cli/) | The `gradient` CLI — the v1 analysis engine. The read-only `scan` pipeline runs end-to-end today. See [`cli/README.md`](cli/README.md). |
| [`docs/`](docs/) | Design spec and implementation plan. |

## Quickstart (CLI)

```bash
npx gradient scan        # this project's history (all of it)
npx gradient scan --user # all projects, last 7 days — your recent cross-project habits
npx gradient scan --all  # all projects, no time limit (thorough; can be slow)
npx gradient review      # inspect the ranked suggestions and their evidence
npx gradient apply <id>  # generate an approved slash-command / loop / hook
```

**Scope.** `scan` defaults to the project you're in. `--user` widens to every
project but bounds it to a recent window (last 7 days, set via `userScopeDays`
in config or `--since`), so it stays fast. A recency cap (`--max-prompts`,
default 1500) protects the clustering step from very large histories and reports
anything it drops.

The default backend reuses your existing `claude` CLI auth — no API key required.
Clustering is local and LLM-free; only short candidate snippets ever reach a model
— never whole transcripts — and a redaction pass strips secrets first.

## Develop

```bash
cd cli && npm install && npm test && npm run build
```

## Status

v1 is the **offline analysis engine**: it mines transcripts and proposes
slash-command / loop / hook artifacts you approve. A live "autopilot" loop (an
LLM-driven `Stop` hook that auto-continues until a task is actually done) is
planned as phase 2.

- Design spec: [`docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md`](docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md`](docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md)

## License

MIT © ylambda
