# gradient CLI

The local-first `gradient` command-line tool.

```bash
npx gradient.md init --target both # configure Claude Code + Codex (existing CLI auth)
npx gradient.md scan      # mine bounded prompt and tool-activity candidates
npx gradient.md review    # approve the ones you want; gradient writes the artifacts
npx gradient.md list      # see what it generated · npx gradient.md remove <name> to undo
npx gradient.md migrate   # convert older generated commands into skills
npx gradient.md recall on # hint when prompts match installed artifacts
npx gradient.md stats     # coverage and artifact adoption
npx gradient.md insights  # local behavior report and recommended actions
npx gradient.md continuity on # preserve context across compact/resume
npx gradient.md bundle team-kit # package approved artifacts as a plugin
```

## How it works

1. Reads enabled local histories: Claude Code (`~/.claude/projects/**/*.jsonl`)
   and Codex (`~/.codex/sessions/**/*.jsonl`). Spawned subagent logs are
   excluded. The Claude pass also pairs Bash calls with their results and notes
   Edit/Write/NotebookEdit events using bounded reads.
2. Clusters repeated prompts, failing-command pastes, recurring sequences, and
   conservative low-impact Q→A preferences locally (no LLM). It separately
   detects commands that fail across sessions and commands repeatedly run after
   edits. Project scans also audit `CLAUDE.md`, `CLAUDE.local.md`, and
   `.claude/rules/*.md` read-only for instructions you keep restating or
   correcting after assistant activity. Tool candidates retain only bounded
   command heads and redacted first error lines—never successful output or file
   contents. Pasted bodies and command arguments are discarded; cross-project
   scans skip Q→A rules. It also measures long Claude question→answer waits with
   bounded local reads.
3. Sends only the top candidates to an LLM (`claude` by default, isolated
   `codex exec --ephemeral` for a Codex-only target, with an Anthropic API-key
   fallback) to name and type them.
4. You inspect the exact rendered artifact and approve; it writes
   `.claude/skills/<name>/SKILL.md`, portable Codex skills under
   `.agents/skills/<name>/SKILL.md`, and project rules under `.claude/rules/`,
   prints `/loop` instructions, or installs explicitly reviewed local hook
   settings that call allowlisted `gradient` subcommands.

Paste and sequence findings are advisory: prior behavior is never treated as
authorization to rerun a command or execute later workflow steps. Preference
rules require repeated support across sessions, are limited to low-impact
format/style/tool choices, and preserve confirmation for consequential actions.
Recurring failures remain advisory rules or skills. A detected post-edit ritual
can become a `PostToolUse` hook only after `review` shows the exact command and
the user approves its automatic execution. Set `"mineToolEvents": false` in
`~/.config/gradient/config.json` to disable tool-event extraction entirely.

Skills are the default because Claude Code can invoke them from their mined
trigger descriptions. Set `emitTarget` to `"command"` in the gradient config
for legacy `.claude/commands/*.md` output. `gradient migrate --dry-run` previews
conversion of manifest-tracked commands; `gradient migrate` performs it without
touching hand-written files. Commands created before the hardened private
approval ledger are skipped; re-scan, review, and apply those workflows first.

Configure `"targets": ["claude-code", "codex"]` to fan approved skills out to
both assistants. The default remains `["claude-code"]`. Mechanical Claude Code
skills use `"cheapSkillModel": "haiku"` by default; set it to `""` to disable
model frontmatter. Codex output stays portable and contains only the Agent
Skills `name` and `description` metadata.

`gradient recall on` installs an LLM-free `UserPromptSubmit` hook in
`.claude/settings.local.json`. Its private user-cache index covers project and
user-level commands and skills; its adoption log stores
only artifact names and match scores, never prompt text. `gradient stats` shows
uses, last use, retypes caught, and stale-artifact removal suggestions.

`scan` writes a private per-project user cache, but it does not install Claude
artifacts or update the autopilot playbook. Approved artifacts are tracked in
`.gradient/manifest.json` so `remove` cleanly undoes them.

Flagged suggestions may include one 2–3 choice clarification. `gradient review`
resolves that choice locally and shows the exact rendered artifact before a
separate approval. The model can propose only bounded, redacted labels; every
installable body is reconstructed from a fixed local authorization guard. The
choice persists in the private user cache and appears in `gradient explain`;
deciding later leaves the suggestion flagged and unapplied.

Five or more Claude Code sessions with waits of at least five minutes produce a
suggested `Notification` hook matched to `permission_prompt|idle_prompt`.
Approved hook output calls the silent `gradient notify` target, which uses only
the static message “Claude Code is waiting on you” via macOS `osascript` or
Linux `notify-send`. Notification failures are ignored, and transcript text is
never passed to the OS. Codex history does not produce this Claude-only hook.

`gradient insights [--user] [--html]` is also LLM-free. It counts behavior
signals such as nudges, interrupts, compacts, error pastes, and model churn,
then routes them to concrete gradient actions. `gradient continuity on`
records private per-project consent and installs paired checkpoint/recap hooks;
the bounded, best-effort-redacted user-intent checkpoint lives in the private
user cache, not the repo, and returns to Claude as explicitly untrusted context.
Raw assistant/tool-output prose is excluded, and `continuity off` deletes it.
`--html` explicitly writes a private `.gradient/insights.html` report.

`gradient bundle <name>` atomically rebuilds a dual Claude Code/Codex plugin under
`.gradient/bundle/<name>/` from manifest-tracked artifacts only. It copies no
raw transcript or cache files, evidence counts, local provenance IDs, or hooks;
artifact text can still quote or derive from redacted prompts. Every source must
match a private exact-content approval from the hardened generator. Legacy,
changed, unapproved, unmarked, and sensitive-looking artifacts are skipped.
Secret detection is best effort, so review every output. The generated README
explains the manual rule-copy/review step. Hook export is disabled until
recipients have their own consent boundary.

## Autopilot (opt-in)

`gradient autopilot` installs a `Stop` hook that answers the nudges you type most
(`continue`, `what's next?`) with the fixed non-authorizing nudge `Continue.`.

```bash
npx gradient.md autopilot nudge    # opt in: push unfinished work forward
npx gradient.md autopilot status   # what did it do while I was away?
npx gradient.md autopilot off      # remove the hook
```

It is consented per project, bounded by paid judge attempts (default 10,
absolute ceiling 100), latches off when it
sees no progress, and fails open — any error means the stop simply stands. The
judge runs in safe mode with tools and customizations disabled; its text is never
relayed. `full` mode is disabled in `0.3.1`. A committed `gradient.md` can only
lower mode or budget through structured frontmatter; repository prose is ignored.

## Model use and billing

gradient uses `claude -p` or isolated `codex exec --ephemeral` calls under the
account and limits of your existing CLI login. `scan` costs one classification
call per run; Claude Code autopilot can call once per stop up to its attempt
budget. For CI or anything shared, use a service credential: set
`ANTHROPIC_API_KEY` and pin `"backend": "anthropic"`; an unavailable pinned
backend fails closed rather than silently falling back.

Candidate snippets (including bounded assistant question text for project-only
preference mining) and autopilot tails are sent to the selected model after
common credential/PII redaction. Redaction cannot identify every kind of
sensitive or proprietary text. Scan input, candidates, caches, playbooks,
settings, and logs have hard resource ceilings; custom `ignorePatterns` use a
capped, linear-looking regex subset. See the repository's
[security and data-boundary documentation](https://github.com/elliot-ylambda/gradient#data-and-trust-boundaries).

Full details: [Model use and billing](https://github.com/elliot-ylambda/gradient#model-use-and-billing).

## Development

This package is built test-first. The complete v2 funnel is specified in
the [v2 funnel design](https://github.com/elliot-ylambda/gradient/blob/main/docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md)
and its five implementation plans under `docs/superpowers/plans/`.

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

## License

MIT © ylambda
