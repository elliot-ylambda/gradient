<div align="center">

# gradient

**The prompts you keep retyping into Claude Code and Codex, compiled into skills.**

`gradient` reads your own Claude Code and Codex history, finds repeated prompts,
recurring command failures, post-edit verification rituals, error pastes, short
preference answers, and recurring sequences, then generates the automations to
stop — **skills, rules, loops, and hooks** — through a
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
It also audits project and user `CLAUDE.md` instructions read-only: when you keep
restating an instruction or correcting the assistant after activity, gradient
can propose a safer rule—or, for an explicit post-edit check, a reviewed hook.

## Repository layout

```
gradient/
  cli/               →  the gradient CLI (TypeScript / npx)
  plugin/            →  the Claude Code plugin — bundled CLI + skills; see plugin/README.md
  .claude-plugin/    →  marketplace manifest so this repo doubles as a plugin marketplace
  docs/              →  design spec and implementation plan
  skills/            →  reusable skills for Claude Code + Codex
```

| Dir | What it is |
|-----|------------|
| [`cli/`](cli/) | The `gradient` CLI. Its local-first `scan` pipeline finds repeated workflows and emits approved artifacts. See [`cli/README.md`](cli/README.md). |
| [`plugin/`](plugin/) | The Claude Code plugin — bundled CLI + skills; see [`plugin/README.md`](plugin/README.md). |
| [`.claude-plugin/`](.claude-plugin/) | Marketplace manifest so this repo doubles as a plugin marketplace. |
| [`docs/`](docs/) | Design spec and implementation plan. |
| [`skills/`](skills/) | Open-standard skills that work in Claude Code and Codex. |

## Skills library

The public skills library starts with [`vibe-security-check`](skills/vibe-security-check/SKILL.md), a defensive pre-launch audit for the auth, data, storage, spend, SSRF, payment, upload, and AI-tool guards commonly missing from rapidly built apps.

Install it globally for both Claude Code and Codex:

```bash
npx skills add elliot-ylambda/gradient --skill vibe-security-check -g -a claude-code -a codex
```

See the [skills catalog](skills/) for usage and the full audit checklist.

## Quickstart

**Plugin (recommended):** in Claude Code run
`/plugin marketplace add ylambda/gradient` then `/plugin install gradient`,
and use `/gradient:scan` → `/gradient:review`. Installing runs nothing —
every automation stays opt-in.

**CLI (npx):**

```bash
npx gradient.md init --target both --session-scan # install + surface one suggestion next session
npx gradient.md             # interactive mirror: top pending suggestions (fresh cache, or bounded scan)
npx gradient.md scan        # prompts, tool rituals/failures, advisory patterns, and preferences
npx gradient.md scan --user # all projects, last 7 days — your recent cross-project habits
npx gradient.md scan --all  # all projects, no time limit (thorough; can be slow)
npx gradient.md review      # approve, explain, or persistently dismiss ranked suggestions
npx gradient.md apply <id|name>...  # generate an approved skill / loop / hook
npx gradient.md migrate     # convert older generated commands into skills
npx gradient.md recall on   # hint when a typed prompt matches an installed artifact
npx gradient.md stats       # estimated leverage plus realized minutes saved from actual use
npx gradient.md insights    # local behavior report + concrete next actions
npx gradient.md continuity on # checkpoint before compaction, recap after resume
npx gradient.md bundle team-kit # package approved artifacts for teammates
```

The npm package is **`gradient.md`**; the command it installs is **`gradient`**.
So `npx gradient.md scan` and, once installed globally, plain `gradient scan`.

The funnel leads you through itself: `init --session-scan` offers a first scan;
after you work, the next session surfaces at most one cached suggestion and
rescans in the background. Interactive bare `gradient` mirrors up to three
pending suggestions straight from the cache when it's fresh — under a day
old — and refreshes it first otherwise; `review` can approve, explain, or
persistently dismiss them, and `stats` reports both estimated leverage and
minutes saved by observed artifact use. Hooks and pipes never prompt;
non-interactive bare invocation continues to print help.

**Scope.** `scan` defaults to the project you're in. `--user` widens to every
project but bounds it to a recent window (last 7 days, set via `userScopeDays`
in config or `--since`), so it stays fast. A recency cap (`--max-prompts`,
default 1500, absolute ceiling 5000) protects the clustering step from very
large histories and reports anything it drops. Transcript discovery also has
file-count, depth, per-file, and aggregate-byte ceilings. Cross-project scans
deliberately skip Q→A preference mining, so a preference learned in one
repository cannot become a rule in another.

Approved skills can be written for both assistants. Add this to
`~/.config/gradient/config.json`:

```json
{
  "targets": ["claude-code", "codex"],
  "cheapSkillModel": "haiku"
}
```

Claude Code skills go to `.claude/skills`; portable Codex skills go to the
documented repository location `.agents/skills`. `cheapSkillModel` is used only
for workflows the judge marks mechanical, and an empty string disables it.

The default backend reuses the CLI auth you already have: `claude` for the
default Claude Code target and `codex exec --ephemeral` for a Codex-only target.
No API key is required for local use.
Prompt clustering and tool-activity mining are local and LLM-free. `scan` sends
bounded candidate snippets—not whole transcripts—to the selected model after
redacting common credential and PII formats. Tool candidates contain only a
bounded command head and, for failures, a redacted first error line; successful
tool output and file contents are never extracted. Redaction is defense in
depth, not a guarantee that arbitrary private or proprietary text is removed;
review the
[data and trust boundaries](#data-and-trust-boundaries) before scanning
sensitive history.

When a frequent pattern is genuinely ambiguous, `review` asks one judge-authored
multiple-choice question. The judge can propose only bounded, redacted labels;
Gradient reconstructs each body from a fixed local authorization guard. Choosing
an interpretation promotes the suggestion to high confidence, then shows the
exact rendered artifact for separate approval. The private cache keeps the
choice for `explain`; declining leaves it flagged and unapplied.

## Model use and billing

gradient uses the selected assistant's non-interactive CLI for short text-only
decisions: `claude -p` or an isolated `codex exec --ephemeral`. Those calls use
the account and limits attached to that CLI login. Two features make calls:

- **`scan`** — one call per run, to name and rank the mined clusters.
- **`autopilot`** — at most `autopilotBudget` judge attempts per session
  (default 10, absolute ceiling 100, clampable lower per repo in `gradient.md`).
  Stand-downs and failed or timed-out calls consume the budget too.

An always-on autopilot is therefore recurring usage, not a free operation. If that
matters, lower the budget or set `max-mode: off` in the repos you don't want it
running in.

**For CI or anything shared, use a service credential rather than a personal
login.** gradient's built-in API path uses Anthropic: set `ANTHROPIC_API_KEY`
and pin the backend. Pinned backends fail closed when unavailable; Gradient
never silently switches identity or billing path:

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

Arbitrary-response `full` mode is disabled in `0.3.1` pending additional
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

Structured frontmatter clamps always enforce. Repository prose reaches your
judge only after you approve it in `gradient review`, which pins those exact
bytes locally; any unapproved edit silently unpins the prose. Trailing `#`
comments are descriptive and ignored. Anything else the parser can't read — an
unclosed block, `max-mode: turbo` — turns autopilot off for that repo rather than
guessing; `gradient autopilot status` shows the effective mode and pin state.

### How the loop is bounded

Claude Code passes a `stop_hook_active` flag so a `Stop` hook can tell it is
already continuing a session, and avoid looping forever. **gradient deliberately
does not gate on it.** For an auto-responder that flag is true whenever the
feature is working — bailing on it would mean autopilot could nudge exactly once
per session and never again.

Three other bounds replace it, and each is independent:

- **Budget** — a hard cap on judge attempts per session (default 10, absolute
  ceiling 100), clampable further per repo.
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

## Attention hooks

If Claude asked a question and waited at least five minutes for an answer in five
or more sessions, `scan` adds one high-confidence Notification-hook suggestion.
Approve it through the normal review flow and gradient merges the hook into
`.claude/settings.local.json` (remove it later with `gradient remove
notify-when-waiting`) for a desktop ping on `permission_prompt` and
`idle_prompt` notifications. `gradient notify` uses
static text only—never transcript content—and fails open through macOS
`osascript` or Linux `notify-send`. This hook is Claude Code-specific; Codex
history remains part of shared habit mining but cannot produce a Claude
lifecycle hook.

## Insights & continuity

`gradient insights` is a local-only report card for the way you work: typed
nudges, interrupted turns, context deaths and compacts, repeated error pastes,
and model/effort churn. It makes no model call. Each hot metric points to a
specific action such as `gradient autopilot nudge`, `gradient scan`, or
`gradient recall on`; `--user` uses the same recent cross-project window as
scan, and `--html` writes a self-contained private
`.gradient/insights.html`. Project reports also show up to 15 instruction
effectiveness findings from the most recent scan.

`gradient continuity on` installs locally consented `PreCompact` checkpoint
and `SessionStart` recap hooks. Bounded, redacted recent user intents plus a
deterministic tool-activity count are stored in the private per-project user
cache and returned as explicitly untrusted context only on `resume|compact`.
Raw assistant/model/tool-output prose is not cached. `continuity off` revokes
consent, deletes the checkpoint, then removes only those two hooks.

## Data and trust boundaries

- `scan` reads user-authored turns from enabled local Claude Code and Codex
  transcripts (excluding Codex subagent rollouts). From Claude Code history it
  also pairs bounded Bash calls with their results and records file-edit events
  locally to detect recurring failures and post-edit rituals. It extracts no
  successful output; at most a redacted 120-character first error line can join
  a candidate. It writes a
  private per-project cache under `~/.config/gradient/projects/`, and sends only
  capped/redacted candidate snippets to the selected model. Project-scoped
  preference mining also reads bounded assistant questions; cross-project scans
  skip that pass. `--user --since` filters individual turn timestamps; every
  scope keeps the default 1,500-prompt processing cap and an absolute 5,000
  prompt ceiling. Tool events have a 400-per-session cap and a 20,000-event
  global cap, with all drops reported. Transcript traversal, individual files,
  total input bytes, candidate count, caches, settings, playbooks, and
  append-only logs are also bounded. Site-specific `ignorePatterns` accept only
  a capped, linear-looking regex subset to avoid backtracking denial of service.
- Project scans read `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md`, and
  the user's `~/.claude/CLAUDE.md` without following imports or symlinks and
  never modify them. Instruction-audit tallies are private `0600` user-cache
  data, not repository files. Corrections count only when same-session
  transcript ordering confirms preceding assistant activity; cross-project
  scans skip the audit so one repository's instructions cannot affect another.
- Suggestions must map to opaque IDs for exact local source candidates; redacted
  text is never used as a provenance key. Artifact bodies, titles, triggers,
  rule text, and hook commands are reconstructed locally, and `review` shows the
  exact rendered artifact before approval. Observed pastes and sequences become
  advisory guides/checklists, not permission to rerun commands or later steps.
- Project writes reject symlinked ancestors and final targets. Caches and user
  state use private modes and atomic writes. Hooks default to
  `.claude/settings.local.json`.
- Headless Claude/Codex classifier children run in fresh private directories,
  receive prompt text over stdin, and do not inherit project instructions.
  Tools, plugins, MCP/apps, browsing, hooks, project docs, rules, and session
  persistence are disabled; Codex additionally runs with a read-only sandbox.
- Autopilot is opt-in per project and sends a bounded recent user/assistant tail
  plus the private personal playbook to the judge. Do not enable it for session
  content you are unwilling to send to the configured model.
- Continuity is opt-in per project. On resume/compact it returns the cached,
  best-effort-redacted user intents to Claude as untrusted context; do not enable
  it for transcript content you are unwilling to put back into model context.
- No API key is stored by Gradient. `ANTHROPIC_API_KEY` is read from the process
  environment by the official SDK.

See [SECURITY.md](SECURITY.md) for supported versions and vulnerability reports.

## Share with your team

After reviewing and applying the workflows you want, package only those
manifest-tracked artifacts as a dual Claude Code/Codex plugin:

```bash
npx gradient.md bundle team-kit              # skills, commands, and project rules
claude --plugin-dir .gradient/bundle/team-kit
```

The bundle includes both `.claude-plugin/plugin.json` and a validated
`.codex-plugin/plugin.json`, with shared portable skills. It copies no raw
transcript or cache files, evidence counts, local
suggestion IDs, hooks, or other personal telemetry. Artifact text can quote or
derive from redacted prompts, so review every bundled file before sharing.
Export additionally requires a private, exact-content approval recorded by the
hardened generator; legacy, changed, unapproved, unmarked, and sensitive-looking
artifacts are skipped. Secret detection is best effort, not a DLP guarantee.
Rules include an explicit manual review/copy instruction because plugins do not
auto-load project rules. Hook export is disabled pending a recipient-side
consent design. The command prints a current-schema marketplace catalog you can
add to a repository alongside the generated plugin directory.

## Develop

```bash
cd cli && npm install && npm test && npm run build
```

Run the packaged synthetic dogfood release gate and open its inspectable HTML
evidence:

```bash
cd cli
npm run dogfood -- --output ../artifacts/dogfood
open ../artifacts/dogfood/report.html # macOS; use your browser elsewhere
```

The gate installs the npm tarball into a disposable consumer and exercises all
advertised commands plus the internal hook targets without reading real history
or calling a real model. See [Dogfooding and release evidence](docs/dogfood.md)
for the 19-scenario matrix and the separate opt-in live checklist.

## Status

The checked-in version in [`cli/package.json`](cli/package.json) is the release
candidate. Published builds use npm's `latest` channel; Gradient is pre-1.0,
not a beta-tagged build. Maintainers can run `make release-check` to verify that
npm, the GitHub release, and the deployed site all agree after publishing.

Phase A of the v2 funnel makes both ends of mining more honest: continuation
summaries, task notifications, configured injectors, and template floods are
excluded from habit detection; approved command-type suggestions now become
model-invoked Claude Code skills under `.claude/skills/` by default. Existing
current-safe gradient-generated commands can be converted with `gradient
migrate` (`--dry-run` previews the change). Pre-0.1.1 commands lack the private
exact-content approval and are skipped; re-scan, review, and apply them first.

**0.6 stable-id migration:** suggestion ids now derive from their source
evidence instead of an LLM-chosen name. After upgrading from an earlier
release, run `gradient scan` and `gradient review`. If an already-applied
artifact appears again, re-apply the reviewed suggestion and remove the old
manifest entry with `gradient remove <name>`. Gradient does not rewrite or
delete existing artifacts automatically.

**0.6 session-start migration:** `gradient session-start` now prints the
single highest-leverage pending suggestion before its detached rescan,
instead of running silently. Existing installs keep the old silent `gradient
scan --detach` hook exactly as configured until they rerun `gradient init
--session-scan`, which migrates it to `gradient session-start` in place.

Set `emitTarget` to `"command"` in the gradient config only when legacy
`.claude/commands/` output is required. Phase B
adds local recall hints and artifact adoption reporting, closing the gap between
generating a workflow and actually using it. Phase C detects repeated pasted
failures, exact recurring sequences, and repeated low-impact preferences across
multiple sessions. It produces advisory troubleshooting/checklist skills and
guarded project-preference rules without retaining pasted error bodies or
inferring authorization from prior behavior.

Phase D adds the LLM-free behavior report and the opt-in continuity pack:
`gradient insights` turns local work signals into concrete next actions, while
`gradient continuity on` preserves a redacted checkpoint across compaction and
resumed sessions. Phase E closes the v2 funnel by packaging current-safe,
exact-content-approved artifacts as validated team plugins, with hook export
disabled and personal evidence stripped.

The multi-assistant stage writes each approved skill for every configured
target, tracks/removes each copy independently, mines both assistants into one
shared evidence pool, and reports the approximate token cost of unautomated
nudges, context re-explains, and repeated error pastes.

Flagged-suggestion clarification and attention hooks complete the remaining
Tier 2 review gaps: ambiguous intent is resolved offline during `review`, and
repeated waiting-on-you gaps can become a narrowly matched desktop ping.

The opt-in `gradient autopilot` Stop-hook responder also ships today. All five
v2 phases are implemented.

- Design spec: [`docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md`](docs/superpowers/specs/2026-06-29-gradient-analysis-engine-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md`](docs/superpowers/plans/2026-06-29-gradient-analysis-engine.md)
- Autopilot design spec: [`docs/superpowers/specs/2026-07-01-gradient-auto-responder-design.md`](docs/superpowers/specs/2026-07-01-gradient-auto-responder-design.md)
- Autopilot implementation plan: [`docs/superpowers/plans/2026-07-01-gradient-auto-responder.md`](docs/superpowers/plans/2026-07-01-gradient-auto-responder.md)
- v2 funnel design: [`docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md`](docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md)
- Phase A implementation plan: [`docs/superpowers/plans/2026-07-06-gradient-v2-phase-a-input-skills.md`](docs/superpowers/plans/2026-07-06-gradient-v2-phase-a-input-skills.md)
- Phase B implementation plan: [`docs/superpowers/plans/2026-07-06-gradient-v2-phase-b-recall-adoption.md`](docs/superpowers/plans/2026-07-06-gradient-v2-phase-b-recall-adoption.md)
- Phase C implementation plan: [`docs/superpowers/plans/2026-07-06-gradient-v2-phase-c-detectors.md`](docs/superpowers/plans/2026-07-06-gradient-v2-phase-c-detectors.md)
- Phase D implementation plan: [`docs/superpowers/plans/2026-07-06-gradient-v2-phase-d-insights.md`](docs/superpowers/plans/2026-07-06-gradient-v2-phase-d-insights.md)
- Phase E implementation plan: [`docs/superpowers/plans/2026-07-06-gradient-v2-phase-e-bundle.md`](docs/superpowers/plans/2026-07-06-gradient-v2-phase-e-bundle.md)
- Codex and cost design: [`docs/superpowers/specs/2026-07-09-gradient-codex-and-cost-design.md`](docs/superpowers/specs/2026-07-09-gradient-codex-and-cost-design.md)
- Codex Stage 2 and cost plan: [`docs/superpowers/plans/2026-07-09-gradient-codex-stage2-cost.md`](docs/superpowers/plans/2026-07-09-gradient-codex-stage2-cost.md)
- Review clarification and attention design: [`docs/superpowers/specs/2026-07-09-gradient-review-clarify-design.md`](docs/superpowers/specs/2026-07-09-gradient-review-clarify-design.md)
- Review clarification and attention plan: [`docs/superpowers/plans/2026-07-09-gradient-review-clarify.md`](docs/superpowers/plans/2026-07-09-gradient-review-clarify.md)
- Dogfood evidence product spec: [`docs/superpowers/specs/dogfood-evidence/PRODUCT.md`](docs/superpowers/specs/dogfood-evidence/PRODUCT.md)
- Dogfood evidence technical design: [`docs/superpowers/specs/dogfood-evidence/TECH.md`](docs/superpowers/specs/dogfood-evidence/TECH.md)

## License

MIT © ylambda
