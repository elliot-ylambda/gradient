<div align="center">

# gradient

**The prompts you keep retyping into Claude Code, compiled into skills.**

`gradient` reads your own Claude Code history, finds the workflows you repeat,
and generates the automations to stop — **skills, loops, and hooks** —
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
  "push and open a PR and review it" repeated every week → skills waiting
  to be named

`gradient` mines those patterns out of your history and hands you the artifact.

## Repository layout

```
gradient/
  cli/    →  the gradient CLI (TypeScript / npx)
  docs/   →  design spec and implementation plan
```

| Dir | What it is |
|-----|------------|
| [`cli/`](cli/) | The `gradient` CLI. Its local-first `scan` pipeline finds repeated workflows and emits approved artifacts. See [`cli/README.md`](cli/README.md). |
| [`docs/`](docs/) | Design spec and implementation plan. |

## Quickstart (CLI)

```bash
npx gradient.md scan        # this project's history (all of it)
npx gradient.md scan --user # all projects, last 7 days — your recent cross-project habits
npx gradient.md scan --all  # all projects, no time limit (thorough; can be slow)
npx gradient.md review      # inspect the ranked suggestions and their evidence
npx gradient.md apply <id>  # generate an approved skill / loop / hook
npx gradient.md migrate     # convert older generated commands into skills
```

The npm package is **`gradient.md`**; the command it installs is **`gradient`**.
So `npx gradient.md scan` and, once installed globally, plain `gradient scan`.

**Scope.** `scan` defaults to the project you're in. `--user` widens to every
project but bounds it to a recent window (last 7 days, set via `userScopeDays`
in config or `--since`), so it stays fast. A recency cap (`--max-prompts`,
default 1500) protects the clustering step from very large histories and reports
anything it drops.

The default backend reuses your existing `claude` CLI auth — no API key required.
Clustering is local and LLM-free; only short candidate snippets ever reach a model
— never whole transcripts — and a redaction pass strips secrets first.

## Usage and billing

gradient calls Claude by spawning `claude -p` (Claude Code's non-interactive
mode). Anthropic covers that under the **Agent SDK credit** included with a Pro
or Max plan — a separate allowance from your interactive Claude Code usage. Two
things draw on it:

- **`scan`** — one call per run, to name and rank the mined clusters.
- **`autopilot`** — one call per stop, bounded by `autopilotBudget` (default 10
  per session, and clampable per repo in `gradient.md`).

An always-on autopilot is therefore a recurring cost, not a free one. If that
matters, lower the budget or set `max-mode: off` in the repos you don't want it
running in.

**For CI or anything shared, use an API key.** Anthropic's guidance is that
shared production automation should run on the Claude Platform with a key rather
than a personal subscription. gradient supports that path — set
`ANTHROPIC_API_KEY` and pin the backend:

```json
// ~/.config/gradient/config.json
{ "backend": "anthropic", "model": "claude-sonnet-4-6" }
```

(Note that an exported `ANTHROPIC_API_KEY` also redirects the default `claude`
CLI backend to API billing, so setting it is enough to move off the subscription
either way.)

## Autopilot (opt-in)

The most-mined pattern in every history is the nudge — `continue`, `what's
next?` — typed hundreds of times. `gradient autopilot` automates exactly that:
a `Stop` hook that answers the way *you* would, using the phrasings mined into
your `gradient.md` (`~/.config/gradient/gradient.md`, yours to edit — `scan`
refreshes only its marked region).

```bash
npx gradient.md autopilot nudge   # opt in (this project): push unfinished work forward
npx gradient.md autopilot full    # also answer routine questions / start your usual next step
npx gradient.md autopilot status  # what did it do while I was away?
npx gradient.md autopilot off     # remove the hook
```

Bounded by design — see [How the loop is bounded](#how-the-loop-is-bounded) below.

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
Trailing `#` comments are descriptive and ignored. Anything else the parser
can't read — an unclosed block, `max-mode: turbo` — turns autopilot off for that
repo rather than guessing; `gradient autopilot status` shows the effective mode.

### How the loop is bounded

Claude Code passes a `stop_hook_active` flag so a `Stop` hook can tell it is
already continuing a session, and avoid looping forever. **gradient deliberately
does not gate on it.** For an auto-responder that flag is true whenever the
feature is working — bailing on it would mean autopilot could nudge exactly once
per session and never again.

Three other bounds replace it, and each is independent:

- **Budget** — a hard cap on auto-responses per session (default 10), clampable
  further per repo.
- **Progress gate** — if Claude stops again having done no tool work since the
  last nudge, autopilot latches off for the session rather than nudging into a
  wall.
- **Fail-open** — any error (no backend, judge timeout, unparseable reply) means
  the stop simply stands. Autopilot's failure mode is "off", never "loops".

The judge also runs with every tool denied, so it can only decide — never act.
Your permission prompts still gate dangerous tools; autopilot cannot answer them.

## Develop

```bash
cd cli && npm install && npm test && npm run build
```

## Status

Phase A of the v2 funnel makes both ends of mining more honest: continuation
summaries, task notifications, configured injectors, and template floods are
excluded from habit detection; approved command-type suggestions now become
model-invoked Claude Code skills under `.claude/skills/` by default. Existing
gradient-generated commands can be converted safely with `gradient migrate`
(`--dry-run` previews the change). Set `emitTarget` to `"command"` in the
gradient config only when legacy `.claude/commands/` output is required.

The opt-in `gradient autopilot` Stop-hook responder also ships today. The next
v2 phases close recall and adoption, add non-lexical detectors, surface local
behavior insights, and package approved artifacts for teams.

- Design spec: [`docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md`](docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md`](docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md)
- Autopilot design spec: [`docs/superpowers/specs/2026-07-01-gradient-auto-responder-design.md`](docs/superpowers/specs/2026-07-01-gradient-auto-responder-design.md)
- Autopilot implementation plan: [`docs/superpowers/plans/2026-07-01-gradient-auto-responder.md`](docs/superpowers/plans/2026-07-01-gradient-auto-responder.md)
- v2 funnel design: [`docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md`](docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md)
- Phase A implementation plan: [`docs/superpowers/plans/2026-07-06-gradient-v2-phase-a-input-skills.md`](docs/superpowers/plans/2026-07-06-gradient-v2-phase-a-input-skills.md)

## License

MIT © ylambda
