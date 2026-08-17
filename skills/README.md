# gradient skills

Open-standard skills for Claude Code and Codex. Both assistants implement the
[Agent Skills standard](https://agentskills.io), so a skill directory copied
into the right place works in either.

## gradient itself

`gradient-optimize`, `gradient-report`, and `gradient-features` are how gradient
is installed for Codex, which has no plugin marketplace. Each is self-contained —
a `SKILL.md` plus the single-file runner it invokes — so a copy is a complete
install, with no package manager, no PATH entry, and nothing global. Use Codex's
built-in installer — the same one the official `openai/skills` catalog uses:

```
$skill-installer install gradient-optimize, gradient-report and gradient-features from elliot-ylambda/gradient
```

That writes to `$CODEX_HOME/skills`. Codex also reads `~/.agents/skills`, and
each skill resolves its runner in **either** — one that hardcoded a single root
would be silently broken for everyone who used the other, which is exactly how
this shipped broken once.

The installer aborts rather than overwrite a destination that already exists, so
updating is a removal and a reinstall, not one command:

```bash
rm -rf ~/.codex/skills/gradient-{optimize,report,features}
```

Claude Code users install the same three skills as a plugin instead — see the
[root README](../README.md).

> **These three are generated.** [`plugin/skills/`](../plugin/skills/) holds the
> authored source; `cli/scripts/skill-render.mjs` derives these from it, and
> `make artifacts` rewrites them. Editing them here is undone by the next build,
> and `cli/src/skills.test.ts` fails when they no longer match. Only the name,
> the runner path, and the Claude-Code-only frontmatter keys differ — everything
> a skill actually says is written once.

## vibe-security-check

Audit a rapidly built web or SaaS application for the security guards that
AI-generated features commonly omit: a ten-check launch-blocker pass based on two
practitioner writeups, plus a broader baseline for secrets, sessions, input
handling, payments, webhooks, uploads, dependencies, logging, and production
configuration.

[Read the skill](vibe-security-check/SKILL.md) · [Review the full checklist](vibe-security-check/references/checklist.md)

Copy it wherever your assistant looks — `~/.claude/skills/vibe-security-check`
for Claude Code, `~/.agents/skills/vibe-security-check` for Codex, or the same
paths inside a project to scope it there:

```bash
cp -R skills/vibe-security-check ~/.agents/skills/
```

Then invoke it explicitly:

```text
# Claude Code
/vibe-security-check Audit this app before launch.

# Codex
$vibe-security-check Audit this app before launch.
```

## Design rules

- Keep the shared workflow assistant-neutral; do not use Claude-only frontmatter
  or Codex-only tool names in a `SKILL.md` that both assistants load.
- Put detailed, selectively loaded guidance in `references/`.
- A skill that invokes a program must name a command that resolves from the
  skill's own directory. A command in a `SKILL.md` is prose until an agent runs
  it, so an unresolvable one is not a degraded skill — it is a skill that can do
  nothing, and nothing finds out until it fails in a session.
- Validate each skill before publishing and test it against a real repository.
