<div align="center">

# gradient

**The prompts you keep retyping into Claude Code, compiled into commands.**

`gradient` reads your own Claude Code history, finds the workflows you repeat,
and generates the automations to stop — **slash commands, loops, and hooks** —
through a read-only **scan** → approve **review** → reversible **apply** flow.
It only ever suggests: nothing runs without you turning it on.

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

## Autopilot (opt-in)

The most-mined pattern in every history is the nudge — `continue`, `what's
next?` — typed hundreds of times. `gradient autopilot` automates exactly that:
a `Stop` hook that answers the way *you* would, using the phrasings mined into
your `gradient.md` (`~/.config/gradient/gradient.md`, yours to edit — `scan`
refreshes only its marked region).

```bash
npx gradient autopilot nudge   # opt in (this project): push unfinished work forward
npx gradient autopilot full    # also answer routine questions / start your usual next step
npx gradient autopilot status  # what did it do while I was away?
npx gradient autopilot off     # remove the hook
```

Bounded by design: a per-session budget (default 10), a progress gate that
stands down when Claude stops twice with no new tool activity, and fail-open
errors — anything unexpected means Claude just stops normally. Your permission
prompts still gate dangerous tools; autopilot cannot answer those.

**Per-repo limits.** Drop a committed `gradient.md` at a repo root to bound
autopilot for everyone who works there. Optional frontmatter clamps authority —
it can only *lower* it, never raise your global setting:

```yaml
---
autopilot:
  max-mode: nudge   # ceiling here: off | nudge | full
  budget: 5         # max auto-responses per session in this repo
---
## Rules
- Never push, deploy, or publish from autopilot in this repo.
```

Everything below the frontmatter is prose the auto-responder reads as context.
Malformed frontmatter turns autopilot off for that repo; `gradient autopilot
status` shows the effective mode.

## Develop

```bash
cd cli && npm install && npm test && npm run build
```

## Status

v1 is the **offline analysis engine**: it mines transcripts and proposes
slash-command / loop / hook artifacts you approve, with continuous mining
keeping your `gradient.md` fresh. The autopilot loop — `gradient autopilot`, an
opt-in `Stop`-hook auto-responder — has now shipped as well; see the
"Autopilot (opt-in)" section above.

- Design spec: [`docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md`](docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md`](docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md)
- Autopilot design spec: [`docs/superpowers/specs/2026-07-01-gradient-auto-responder-design.md`](docs/superpowers/specs/2026-07-01-gradient-auto-responder-design.md)
- Autopilot implementation plan: [`docs/superpowers/plans/2026-07-01-gradient-auto-responder.md`](docs/superpowers/plans/2026-07-01-gradient-auto-responder.md)

## License

MIT © ylambda
