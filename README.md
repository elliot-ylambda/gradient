<div align="center">

<img src="assets/logo.svg" width="72" height="72" alt="">

# gradient

**One command that reads how you actually work and keeps your Claude Code and Codex setup honest.**

`gradient optimize` mines your own local transcripts *and* reads the configuration
your assistants actually load, then proposes one ranked list of changes: skills to
create, retire, or repair; instructions the repository has outgrown; the one-line
bridge that makes a single setup serve both assistants. It only ever suggests —
nothing is written without you approving it, and every write is reversible.

[gradient.md](https://gradient.md) · open source · MIT

</div>

---

## Why

A dogfooding run over real history — 2,800+ transcripts, ~5k typed prompts —
found the same things everyone has:

- `continue` / `what's next?` typed **hundreds** of times → a loop nobody set up
- `/compact` run **143×** → a `PreCompact` checkpoint you keep forgetting
- a CLAUDE.md line naming a script that was deleted three weeks ago
- 32 installed skills spending **9,191 characters of context in every session**,
  several of which nothing has ever invoked

None of that is visible from inside a session. All of it is visible from the
outside, across sessions — which is the one thing neither assistant can do for
you, and the only thing gradient claims.

## Install

Each product's own installer, and nothing else — no package manager, no PATH
entry, nothing global. The only requirement is Node.

**Claude Code** — the plugin, from this repository as a marketplace:

```
/plugin marketplace add elliot-ylambda/gradient
/plugin install gradient@gradient
```

Same thing from a terminal, if you prefer: `claude plugin marketplace add
elliot-ylambda/gradient` then `claude plugin install gradient@gradient`.

**Codex** — the skills, through the built-in installer:

```
$skill-installer install gradient-optimize, gradient-report and gradient-features from elliot-ylambda/gradient
```

Either way you get the same three skills, and the same runner byte for byte:

| | Claude Code | Codex |
|---|---|---|
| `optimize` | `/gradient:optimize` | `$gradient-optimize` |
| the report | `/gradient:report` | `$gradient-report` |
| `on`/`off` | `/gradient:features` | `$gradient-features` |

Claude Code namespaces a plugin's skills for you; the Codex copies carry the
`gradient-` prefix themselves, because skills there share one flat namespace and
a skill called `optimize` would be a landgrab.

Each skill directory is self-contained — a `SKILL.md` plus the single-file
runner it invokes — so there is nothing else to fetch and nothing beyond Node to
keep current. Installing runs nothing on its own; every automation stays opt-in.

**Updating** is one step in Claude Code and two in Codex, because the two
installers differ. `claude plugin update gradient@gradient`, then restart —
hooks resolve the newest installed version when they fire, so one that was
turned on before the update keeps working. Codex's `$skill-installer` aborts
rather than overwrite a directory that already exists, so remove the three
first and then run the install line again:

```bash
rm -rf ~/.codex/skills/gradient-{optimize,report,features}
```

## The four verbs

| | |
|---|---|
| `gradient` | The report. What your habits cost, what is installed and whether it is used, what other sessions are doing. Read-only. |
| `gradient optimize` | Find what recurs and what has gone stale, then propose the changes. |
| `gradient remove <name>` | Uninstall a generated artifact — one carrying gradient's own marker, never a file you wrote. |
| `gradient on\|off <feature>` | `continuity` · `autopilot` · `board` · `optimize` |

Nothing puts a `gradient` on your PATH, so `gradient` above is shorthand for the
runner the installed skill names — `${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs` in
the plugin, `~/.codex/skills/gradient-optimize/bin/gradient.mjs` in Codex. The
skills already know it; ask your assistant to optimize your setup and it runs
these for you. If you want to drive it yourself, `help` and the report both open
by naming the runner they resolved, and `optimize` prints its own next command
fully resolved — copy either and it runs:

```bash
gradient optimize                      # propose
gradient optimize --json               # hand the findings to your assistant
gradient optimize --page               # a local checkup page you click through
gradient optimize --apply a1b2,c3d4    # apply exactly these
gradient optimize --undo <runId>       # put it all back
gradient optimize --auto               # headless; additive, reversible changes only
```

## What it finds

| family | what it means |
|---|---|
| `drift` | The two assistants' configurations disagree — usually the missing `@AGENTS.md` import |
| `stale` | An instruction names a path, script, or task the repository no longer has |
| `skill-health` | A skill will not load, will not be selected, carries frontmatter outside the spec, or costs context for nothing |
| `dead-letter` | A written instruction you keep retyping anyway |
| `workflow` | A repeated habit worth turning into a skill, rule, or hook |
| `practice` | Conformance to published guidance — file length, path-scoped rules |
| `memory` | Read-only observations about auto memory. gradient never edits it |

Not every finding carries a change. A portability problem or an unused artifact
gradient did not generate is reported and explained, and `optimize` says so
rather than offering an `--apply` that would refuse.

`stale` is the one that keeps a CLAUDE.md true as the code moves out from under
it. `dead-letter` is the one neither assistant can tell you: you are paying an
instruction's context cost *and* typing it anyway, which means it is not holding.

## One setup, both assistants

Claude Code reads `CLAUDE.md` and never `AGENTS.md`. If your repository has both
Claude and Codex users, gradient proposes the documented one-line fix first:

```markdown
@AGENTS.md

## Claude Code
Everything below is Claude-specific.
```

Once bridged, one file serves both, and every later rule is written once instead
of twice. Where a rule has to be written per-assistant, gradient puts it where
each product actually loads it: `.claude/rules/gradient-*.md` for Claude Code
(auto-loaded at launch), and a single tagged line under its own `## gradient`
heading in `AGENTS.md` for Codex, which has no rules directory.

## The split that makes it safe

> **The CLI is local, offline, and deterministic. The skill brings the model and the network.**

The CLI makes **no network calls, ever**, and calls no model. It computes only
what is checkable: a path that does not exist, a frontmatter key outside the
spec, a description past the listing cap, an artifact unused for thirty days, a
phrase you typed nine times that your CLAUDE.md already contains. That is what
lets it run in a hook, on a schedule, and with no API key.

The skills — the same three `SKILL.md` files in both Claude Code and Codex —
bring what the CLI cannot: judgment for rewriting prose, and a connection for
checking that today's published guidance is still what gradient thinks it is.

The same line decides what `--auto` may do unattended: deterministic, additive,
reversible, gradient-owned changes only. It never edits prose a person wrote.

## Run it on a schedule

```bash
gradient on optimize                 # re-check after a session ends, at most daily
gradient optimize --print-schedule   # a cron/launchd/schtasks snippet for your platform
```

The snippet resolves the runner itself, so a scheduled run needs no PATH entry
either — a cron or launchd job gets a minimal environment and no shell profile,
which is where a command that needs one fails silently.

gradient installs no daemon and owns no timer. `--print-schedule` prints the
snippet; installing it stays your decision, and so does removing it.

## Data and trust boundaries

- **The CLI never makes a network call.** Mining, inspection, findings, and
  application are entirely local. No API key is stored or required.
- `optimize` reads user-authored turns from enabled local Claude Code and Codex
  transcripts (excluding Codex subagent rollouts), pairs bounded Bash calls with
  their results, and records file-edit events locally to detect recurring
  failures and post-edit rituals. It extracts no successful output; at most a
  redacted 120-character first error line can join a candidate. Traversal, file
  sizes, total bytes, candidate counts, caches, settings, and logs are all
  bounded, and every drop is reported.
- **Text mined from transcripts becomes instructions an agent obeys**, so every
  proposed instruction line is redacted, length-capped, stripped of URLs and
  code blocks, and screened against a shell/credential/network lexicon. Any line
  carrying a command invocation is barred from `--auto` in every family.
- Artifact bodies, titles, triggers, rule text, and hook commands are
  reconstructed locally from your own history; nothing is copied through a model.
- Every write to a file gradient does not own is snapshotted first and
  reversible with `--undo`. Each edit carries the exact text it expects to find
  and is refused if the file has moved on; creates never overwrite, and gradient
  deletes only a file carrying its own marker. Concurrent sessions take an
  advisory lock. Symlinked ancestors and final targets are refused.
- gradient **never** writes to or deletes from Claude Code's auto-memory
  directory, and never deletes a file it did not generate.
- Autopilot and continuity are opt-in per project and do send session content to
  a model. Read their sections before enabling either.

See [SECURITY.md](SECURITY.md) for supported versions and vulnerability reports.

## Repository layout

| Dir | What it is |
|-----|------------|
| [`cli/`](cli/) | The CLI's TypeScript source. Not published anywhere; it is built into the runner both shipping shapes carry. See [`cli/README.md`](cli/README.md). |
| [`plugin/`](plugin/) | The Claude Code plugin — the runner plus the three authored skills. |
| [`skills/`](skills/) | The Codex skills `$skill-installer` fetches. `gradient-*` are generated from `plugin/skills/`; see [`skills/README.md`](skills/README.md). |
| [`docs/`](docs/) | [`dogfood.md`](docs/dogfood.md) is current; [`superpowers/`](docs/superpowers/) is a dated record of what was designed, not documentation. |
| [`assets/`](assets/) | Logo marks. |

## Develop

```bash
make test            # the CLI suite
make build           # compile cli/ to dist/
make artifacts       # rebuild the plugin bundle and the three skill directories
npm --prefix cli run dogfood   # build, install by copying, and drive the real runner end to end
```

The dogfood harness is the real gate: it installs both shipping shapes into a
disposable home where each product's own installer puts them, then reads every
SKILL.md, runs the command it names with no `gradient` on PATH, and drives every
verb against synthetic Claude Code and Codex histories. It asserts that every
command in `--help` has a scenario, so the surface cannot drift from its
coverage. A skill's command is prose until something runs it, which is how three
separate releases shipped one that could not resolve.

## License

MIT. See [LICENSE](LICENSE).
