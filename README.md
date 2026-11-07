<div align="center">
<img src="assets/logo.svg" width="72" height="72" alt="">

# gradient

**A local setup checkup for Claude Code and Codex.**

Find stale instructions, inspect installed skills, and review recurring habits.
See the evidence, choose a fix, and undo it if you change your mind.

[gradient.md](https://gradient.md) · [How it compares with native tools](docs/native-tools.md) · MIT
</div>

## One useful loop

Your agent instructions can keep naming a script long after the script is gone.
A skill can live in a different directory from the one you expected. Two
assistants can load different instructions in the same repository.

Gradient checks local files and bounded session history, then separates **fixes
it can apply** from **observations that need your judgment**. Each finding names
its evidence. No model, network call, or API key is needed for the checkup.

1. Ask your assistant: **“Use Gradient to check this project's setup.”**
2. Review the findings and proposed changes in the conversation or local page.
3. Choose the fixes. Rerun to verify them, or undo the run.

An illustrative case: `CLAUDE.md` still says to run `scripts/old-check.sh`.
Gradient shows the missing path and the exact instruction line. You decide
whether to remove that stale instruction or have your assistant update it to the
current command. Gradient does not invent the replacement.

## Install

Requires **Node.js 20 or later**. Installing adds skills and their bundled runner;
it enables no background features and creates no `gradient` command on PATH.

**Claude Code** — run in a session:

```text
/plugin marketplace add elliot-ylambda/gradient
/plugin install gradient@gradient
```

**Codex** — ask its built-in installer:

```text
$skill-installer install gradient-optimize, gradient-report and gradient-features from elliot-ylambda/gradient
```

| Action | Claude Code | Codex |
|---|---|---|
| Check the setup | `/gradient:optimize` | `$gradient-optimize` |
| Read the activity report | `/gradient:report` | `$gradient-report` |
| Manage optional Claude hooks | `/gradient:features` | `$gradient-features` |

Each skill uses its own bundled runner, including custom install locations.
Codex can run the checkup and report. Of the optional hooks, memory installs
for Claude Code and Codex; continuity, autopilot, board, and periodic checkups
install for Claude Code only.

To update Claude Code: `claude plugin update gradient@gradient`, then restart.
For Codex, remove only the three installed Gradient skill directories and rerun
the installer; it refuses to overwrite existing directories. Use their actual
installation paths, especially with a custom `CODEX_HOME` or `--dest`.

## Check, choose, verify

The skills run commands for you. For manual use, replace `/path/to/gradient.mjs`
with the runner in your installed skill's `bin` directory, or the plugin's `bin`.
`help` prints the resolved invocation.

```sh
node /path/to/gradient.mjs optimize --target both
node /path/to/gradient.mjs optimize --json
node /path/to/gradient.mjs optimize --apply <id>,<id> --deny <id>
node /path/to/gradient.mjs optimize
node /path/to/gradient.mjs optimize --changes
node /path/to/gradient.mjs optimize --restore
node /path/to/gradient.mjs optimize --undo <runId>
```

The first run remembers which assistants to inspect. Project scope is the
default; `--user` or `--all` explicitly includes cross-project history.

- **Apply** is offered only when Gradient has a concrete change. Informational
  findings require review, and cannot claim a successful repair.
- **Restore point.** The first `--apply` of a session first saves every
  instruction file both assistants load: CLAUDE.md, CLAUDE.local.md, AGENTS.md
  and AGENTS.override.md anywhere in the repository and at user level, project
  settings, `~/.codex/config.toml`, and the text files under `.claude/rules`,
  `skills`, `commands`, `agents`, `.agents/skills`, and `.codex`. Take one
  yourself with `--checkpoint` before editing by hand, or before your assistant
  rewrites an instruction file for you.
- **Changes** shows every change since the restore point as a diff — applied
  fixes and hand edits alike, including files created or deleted since.
- **Restore** puts all of it back, removes files created since, and keeps
  symbolic links as links. It saves the state it replaces first and prints the
  command that reverses it.
- **Deny** remembers any finding while its evidence is unchanged.
- **Undo** reverses one `--apply`: generated artifacts and associated state. If a later edit
  conflicts, the run is left intact and the conflict is reported. The latest ten applied
  runs and ten restore points are retained independently of read-only reports.
- **Remove** explicitly uninstalls one Gradient-owned artifact:
  `node /path/to/gradient.mjs remove <name>`.
- **Automatic mode** and periodic checks only propose changes. The legacy
  `--auto` flag is kept for existing schedules and no longer applies repairs.

## What the evidence means

| Check | What you can verify |
|---|---|
| Stale references | An instruction names a missing file, package script, or Make target |
| Instruction loading | Which inspected files apply to which assistant, including precedence and explicit imports |
| Skill health | Installed locations, descriptions, and compatibility observations |
| Repeated behavior | Counts from observed events or clearly labeled interpretations of repeated prompts |
| Auto memory | Which notes `MEMORY.md` links (only those load), how many of your corrections it leaves out, and notes too large to be memories |

Claude Code can now read `AGENTS.md` directly in supported configurations.
Gradient proposes an import only when the inspected configuration needs one.

A bounded history scan cannot establish that a skill has **never** been used.
Description lengths are inventory measurements, not tokens or money saved.
Skill and memory advice uses a documented baseline; the skill checks current
published guidance before turning that advice into a recommendation. Some
managed, remote, or unsupported configuration surfaces may remain outside the
scan; an empty result is not a certification of the whole setup.

## Use native tools where they fit

Claude Code already provides `/insights`, `/doctor`, `/skill-doctor`, and skill
evaluation. Codex has skill creation, memories, scheduled tasks, and hooks.
Use their native tools for general review, compaction, memory, and automation.
Gradient focuses on concrete, locally checkable evidence across both setups and
reviewed fixes. It does not claim unique access to session history or measured
productivity gains. See the [dated comparison and primary sources](docs/native-tools.md).

## Optional background features

These are secondary and opt-in, configured per repository:

- `memory` (Claude Code and Codex): start every session in the repository, in
  either assistant, with a short list of your corrections from Claude Code's
  auto memory. In Claude Code that means the ones `MEMORY.md` doesn't load;
  Codex, which can't read Claude's memory, gets them all. The hooks are user-level
  (`~/.claude/settings.json`, `~/.codex/hooks.json`) so every worktree is
  covered, and consent is per repository. Codex runs the hook after you
  review it once with `/hooks`.
- `optimize`: propose a fresh checkup after a session, at most daily, and show the
  top pending finding at the next start.
- `board`: summarize other observed sessions in the repository.
- `continuity`: save a bounded checkpoint and read it back on resume.
- `autopilot`: may send "Continue." when Claude stops before a step it said it
  would take, or after an API error cut a response off. It never answers a
  question for you, and stays out entirely when the last message names a push,
  deploy, release, merge, deletion, migration, message, or spend. The judge is
  Claude Haiku by default, or GPT-6 Luna with `"backend": "codex-cli"` and
  `"codexModel": "gpt-6-luna"` in `~/.config/gradient/config.json`.

The rest are **Claude Code hooks**. Use `node /path/to/gradient.mjs on|off <feature>`.
Turning on one of them in a Codex-only setup is refused with an explanation. Existing global optimize consent requires re-enabling for
the intended project. Native memory, scheduling, and continuation should be your
first choice when they meet the need.

`optimize --print-schedule` prints a platform-specific command; Gradient installs
no daemon or timer. You own installing and removing any external schedule.

## Data and safety

The checkup stays local and deterministic. History collection is bounded and
redacted; inferred habits are evidence for review, never standing permission.
Continuity saves a local checkpoint and feeds it into the existing Claude
session. Autopilot calls a separate model judge through the configured backend
and may incur usage charges. Board and reports use local session and Git data;
they do not fetch GitHub context. Memory reads the one-line descriptions of
Claude Code's auto-memory notes, writes nothing there, and adds its list only to
sessions in repositories you turned it on for, marked as untrusted reference.

Changes use exact preconditions, snapshots, and an advisory lock. Writes refuse
symlinked paths. Gradient never modifies assistant-managed auto memory and never
deletes a file it did not generate. A later user edit is preserved during undo.

See [SECURITY.md](SECURITY.md) and [dogfood evidence](docs/dogfood.md) for the
boundaries and the difference between synthetic checks and observed live behavior.

## Develop

```sh
make test
make build
make artifacts
npm --prefix cli run dogfood
```

`cli/` contains the TypeScript source; `plugin/` contains the authored skills;
`skills/gradient-*` are generated Codex copies. Both ship the same runner.
The [development guide](cli/README.md) covers validation. Historical designs in
`docs/superpowers/` are records, not current usage instructions.

MIT. See [LICENSE](LICENSE).
