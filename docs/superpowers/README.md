# Specs and plans

Dated records of what was designed and built, kept as written. They are **not**
current documentation, and several describe a gradient that no longer exists:

- **Verbs.** The surface collapsed to four — the bare report, `optimize`,
  `remove`, and `on|off`. Plans here still say `init`, `scan`, `review`,
  `apply`, `list`, `retire`, `bundle`, `insights`, `stats`, and `explain`.
- **Distribution.** gradient was an npm package until 0.8.0 and is now published
  to no registry: it ships as files in this repository — the Claude Code plugin
  and the copied skill directories. Plans here still say `npx gradient …`, and
  `gradient.md` was unpublished from npm on 2026-08-17.

For what gradient does today, read the [root README](../../README.md); for how
it is built and released, [CLAUDE.md](../../CLAUDE.md); for the shipping
artifacts, [`plugin/`](../../plugin/) and [`skills/`](../../skills/).

Rewriting these to match today would destroy the thing they are for — a record
of what was decided, and when, including the parts that were later undone.
Grep the current source before treating anything here as implemented.
