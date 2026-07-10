# gradient CLI

The local-first `gradient` command-line tool.

```bash
npx gradient.md init --target both # configure Claude Code + Codex (existing CLI auth)
npx gradient.md scan      # read-only: find repeated prompts, error pastes, and answers
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
   and Codex (`~/.codex/sessions/**/*.jsonl`). Spawned subagent logs are excluded.
2. Clusters repeated prompts, failing-command pastes, and short Q→A preferences
   locally (no LLM) into candidate patterns. It also measures long
   question→answer waits; pasted bodies are discarded.
3. Sends only the top candidates to an LLM (`claude` by default, `codex exec`
   for a Codex-only target, with an Anthropic API-key fallback) to name and type them.
4. You approve; it writes `.claude/skills/<name>/SKILL.md`, portable Codex
   skills under `.agents/skills/<name>/SKILL.md`, and project rules under
   `.claude/rules/`, prints `/loop` or user-rule instructions, or proposes
   `settings.json` hooks that call `gradient` subcommands.

Skills are the default because Claude Code can invoke them from their mined
trigger descriptions. Set `emitTarget` to `"command"` in the gradient config
for legacy `.claude/commands/*.md` output. `gradient migrate --dry-run` previews
conversion of manifest-tracked commands; `gradient migrate` performs it without
touching hand-written files.

Configure `"targets": ["claude-code", "codex"]` to fan approved skills out to
both assistants. The default remains `["claude-code"]`. Mechanical Claude Code
skills use `"cheapSkillModel": "haiku"` by default; set it to `""` to disable
model frontmatter. Codex output stays portable and contains only the Agent
Skills `name` and `description` metadata.

`gradient recall on` installs an LLM-free `UserPromptSubmit` hook. Its local
index covers project and user-level commands and skills; its adoption log stores
only artifact names and match scores, never prompt text. `gradient stats` shows
uses, last use, retypes caught, and stale-artifact removal suggestions.

Flagged suggestions may include one 2–3 choice clarification. `gradient review`
resolves that choice locally, persists the selected full body, and shows the
decision later in `gradient explain`; deciding later leaves the suggestion
flagged and unapplied.

Five or more Claude Code sessions with waits of at least five minutes produce a
suggested `Notification` hook matched to `permission_prompt|idle_prompt`.
Approved hook output calls the silent `gradient notify` target, which uses only
the static message “Claude Code is waiting on you” via macOS `osascript` or
Linux `notify-send`. Notification failures are ignored, and transcript text is
never passed to the OS. Codex history does not produce this Claude-only hook.

`gradient insights [--user] [--html]` is also LLM-free. It counts behavior
signals such as nudges, interrupts, compacts, error pastes, and model churn,
quantifies the approximate tokens spent on automatable habits, then routes them
to concrete gradient actions. `gradient continuity on`
installs the paired, reversible checkpoint/recap hooks that preserve a redacted
`progress.md` across compaction and resumed sessions.

`gradient bundle <name> [--with-hooks]` rebuilds a dual Claude Code/Codex plugin under
`.gradient/bundle/<name>/` from manifest-tracked artifacts only. It never copies
the suggestion cache or evidence counts. The generated README explains the
manual rule-copy step and the optional hooks' `gradient` dependency.

Nothing is written until you approve it in `review`, and everything written is
tracked in `.gradient/manifest.json` so `remove` cleanly undoes it.

## Autopilot (opt-in)

`gradient autopilot` installs a `Stop` hook that answers the nudges you type most
(`continue`, `what's next?`) using the phrasings mined into your `gradient.md`.

```bash
npx gradient.md autopilot nudge    # opt in: push unfinished work forward
npx gradient.md autopilot status   # what did it do while I was away?
npx gradient.md autopilot off      # remove the hook
```

It is bounded by a per-session budget, latches off when it sees no progress, and
fails open — any error means the stop simply stands. The judge runs with every
tool denied, so it can only decide, never act. A committed `gradient.md` at a
repo root can lower autopilot's authority for everyone, never raise it.

## Model use and billing

gradient uses `claude -p` or isolated `codex exec --ephemeral` calls under the
account and limits of your existing CLI login. `scan` uses one classification
call per run; Claude Code autopilot uses one decision call per stop. For CI or
anything shared, set `ANTHROPIC_API_KEY` and pin `"backend": "anthropic"`.

Full details: [Usage and billing](https://github.com/elliot-ylambda/gradient#usage-and-billing).

## Development

This package is built test-first. The complete v2 funnel is specified in
the [v2 funnel design](https://github.com/elliot-ylambda/gradient/blob/main/docs/superpowers/specs/2026-07-06-gradient-v2-funnel-design.md)
and its five implementation plans under `docs/superpowers/plans/`.

```bash
npm install
npm test         # vitest
npm run build    # tsc → dist/
```

## License

MIT © ylambda
