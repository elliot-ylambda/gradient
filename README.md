<div align="center">

# gradient

**The prompts you keep retyping into Claude Code, compiled into skills.**

`gradient` reads your own Claude Code history, finds repeated prompts, error
pastes, short preference answers, and recurring sequences, then generates the
automations to stop — **skills, rules, loops, and hooks** — through a
local-mining **scan** → approve **review** → reversible **apply** flow.
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
npx gradient.md scan        # prompts, advisory paste/sequence patterns, and safe preferences
npx gradient.md scan --user # all projects, last 7 days — your recent cross-project habits
npx gradient.md scan --all  # all projects, no time limit (thorough; can be slow)
npx gradient.md review      # inspect the ranked suggestions and their evidence
npx gradient.md apply <id>  # generate an approved skill / loop / hook
npx gradient.md migrate     # convert older generated commands into skills
npx gradient.md recall on   # hint when a typed prompt matches an installed artifact
npx gradient.md stats       # coverage plus artifact adoption
```

The npm package is **`gradient.md`**; the command it installs is **`gradient`**.
So `npx gradient.md scan` and, once installed globally, plain `gradient scan`.

**Scope.** `scan` defaults to the project you're in. `--user` widens to every
project but bounds it to a recent window (last 7 days, set via `userScopeDays`
in config or `--since`), so it stays fast. A recency cap (`--max-prompts`,
default 1500) protects the clustering step from very large histories and reports
anything it drops. Cross-project scans deliberately skip Q→A preference mining,
so a preference learned in one repository cannot become a rule in another.

The default backend reuses your existing `claude` CLI auth — no API key required.
Clustering is local and LLM-free. `scan` sends bounded candidate snippets—not
whole transcripts—to the selected model after redacting common credential
formats. Redaction is defense in depth, not a guarantee that arbitrary private
or proprietary text is removed; review the [data and trust boundaries](#data-and-trust-boundaries)
before scanning sensitive history.

## Usage and billing

gradient calls Claude by spawning `claude -p` (Claude Code's non-interactive
mode). Anthropic covers that under the **Agent SDK credit** included with a Pro
or Max plan — a separate allowance from your interactive Claude Code usage. Two
things draw on it:

- **`scan`** — one call per run, to name and rank the mined clusters.
- **`autopilot`** — at most `autopilotBudget` judge attempts per session
  (default 10, clampable lower per repo in `gradient.md`). Stand-downs and
  failed or timed-out calls consume the budget too.

An always-on autopilot is therefore a recurring cost, not a free one. If that
matters, lower the budget or set `max-mode: off` in the repos you don't want it
running in.

**For CI or anything shared, use an API key.** Anthropic's guidance is that
shared production automation should run on the Claude Platform with a key rather
than a personal subscription. gradient supports that path — set
`ANTHROPIC_API_KEY` and pin the backend. Pinned backends fail closed when
unavailable; Gradient never silently switches identity or billing path:

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
a local `Stop` hook whose isolated judge can return only the fixed nudge
`Continue.`. Approved patterns are recorded in your private
`~/.config/gradient/gradient.md`; unapproved scan output never reaches it.

```bash
npx gradient.md autopilot nudge   # opt in (this project): push unfinished work forward
npx gradient.md autopilot status  # what did it do while I was away?
npx gradient.md autopilot off     # remove the hook
```

Arbitrary-response `full` mode is disabled in `0.1.1` pending additional
prompt-injection hardening. Enabling nudge records consent for the canonical
project path in private user config and installs the hook in
`.claude/settings.local.json`. A stale or committed hook is inert without that
local consent.

Bounded by design — see [How the loop is bounded](#how-the-loop-is-bounded) below.

**Per-repo limits.** Drop a committed `gradient.md` at a repo root to bound
autopilot for everyone who works there. Optional frontmatter clamps authority —
it can only *lower* it, never raise your global setting:

```yaml
---
autopilot:
  max-mode: nudge   # ceiling here: off | nudge
  budget: 5         # max judge attempts per session in this repo
---
## Rules
- Never push, deploy, or publish from autopilot in this repo.
```

Only the structured frontmatter clamps are read by autopilot. Repository prose
is never passed to the judge as instructions. Trailing `#` comments are
descriptive and ignored. Anything else the parser
can't read — an unclosed block, `max-mode: turbo` — turns autopilot off for that
repo rather than guessing; `gradient autopilot status` shows the effective mode.

### How the loop is bounded

Claude Code passes a `stop_hook_active` flag so a `Stop` hook can tell it is
already continuing a session, and avoid looping forever. **gradient deliberately
does not gate on it.** For an auto-responder that flag is true whenever the
feature is working — bailing on it would mean autopilot could nudge exactly once
per session and never again.

Three other bounds replace it, and each is independent:

- **Budget** — a hard cap on judge attempts per session (default 10), clampable
  further per repo.
- **Progress gate** — if Claude stops again having done no tool work since the
  last nudge, autopilot latches off for the session rather than nudging into a
  wall.
- **Fail-open** — any error (no backend, judge timeout, unparseable reply) means
  the stop simply stands. Autopilot's failure mode is "off", never "loops".

The judge runs in Claude safe mode, with built-in tools, skills, plugins, hooks,
MCP servers, Chrome, and session persistence disabled. Prompt text is sent over
stdin rather than process arguments. The model's response text is never relayed;
only its continue/stand-down decision is used, and continue maps to `Continue.`.

## Recall & adoption

Generating a skill is only half the loop; remembering it at typing time is the
other half. `gradient recall` installs a per-project, LLM-free
`UserPromptSubmit` hook that compares a typed prompt with project and user-level
commands and skills. A close match adds a one-line context hint so Claude can
follow the installed workflow without rewriting or blocking the prompt.

```bash
npx gradient.md recall on      # install the hook and build its local index
npx gradient.md recall status  # hook state, artifact count, and index timestamp
npx gradient.md recall off     # remove only the recall hook
```

The index and adoption log live in private `0600` files under
`~/.config/gradient/projects/`, keyed by project path—not in the repository.
Matching events contain only artifact name, timestamp, similarity, and whether
a hint was shown; prompt text is never logged. Recall also requires local
per-project consent, so a repository cannot activate it by committing a hook.
`gradient stats` reports
uses, last use, and retypes caught for each approved artifact, and suggests
removing artifacts that remain unused for at least 30 days.

## Data and trust boundaries

- `scan` reads user-authored turns from local Claude Code transcripts, writes a
  private per-project cache under `~/.config/gradient/projects/`, and sends only
  capped/redacted candidate snippets to the selected model. Project-scoped
  preference mining also reads bounded assistant questions; cross-project scans
  skip that pass. `--user --since` filters individual turn timestamps; every
  scope keeps the default 1,500-prompt processing cap.
- Suggestions must map to opaque IDs for exact local source candidates; redacted
  text is never used as a provenance key. Artifact bodies, titles, triggers,
  rule text, and hook commands are reconstructed locally, and `review` shows the
  exact rendered artifact before approval. Observed pastes and sequences become
  advisory guides/checklists, not permission to rerun commands or later steps.
- Project writes reject symlinked ancestors and final targets. Caches and user
  state use private modes and atomic writes. Hooks default to
  `.claude/settings.local.json`.
- Autopilot is opt-in per project and sends a bounded recent user/assistant tail
  plus the private personal playbook to the judge. Do not enable it for session
  content you are unwilling to send to the configured model.
- No API key is stored by Gradient. `ANTHROPIC_API_KEY` is read from the process
  environment by the official SDK.

See [SECURITY.md](SECURITY.md) for supported versions and vulnerability reports.

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
gradient config only when legacy `.claude/commands/` output is required. Phase B
adds local recall hints and artifact adoption reporting, closing the gap between
generating a workflow and actually using it. Phase C detects repeated pasted
failures, exact recurring sequences, and repeated low-impact preferences across
multiple sessions. It produces advisory troubleshooting/checklist skills and
guarded project-preference rules without retaining pasted error bodies or
inferring authorization from prior behavior.

The opt-in `gradient autopilot` Stop-hook responder also ships today. The next
v2 phases surface local behavior insights and package approved artifacts for
teams.

- Design spec: [`docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md`](docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md`](docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md)
- Autopilot design spec: [`docs/superpowers/specs/2026-07-01-gradient-auto-responder-design.md`](docs/superpowers/specs/2026-07-01-gradient-auto-responder-design.md)
- Autopilot implementation plan: [`docs/superpowers/plans/2026-07-01-gradient-auto-responder.md`](docs/superpowers/plans/2026-07-01-gradient-auto-responder.md)
- v2 funnel design: [`docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md`](docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md)
- Phase A implementation plan: [`docs/superpowers/plans/2026-07-06-gradient-v2-phase-a-input-skills.md`](docs/superpowers/plans/2026-07-06-gradient-v2-phase-a-input-skills.md)
- Phase B implementation plan: [`docs/superpowers/plans/2026-07-06-gradient-v2-phase-b-recall-adoption.md`](docs/superpowers/plans/2026-07-06-gradient-v2-phase-b-recall-adoption.md)

## License

MIT © ylambda
