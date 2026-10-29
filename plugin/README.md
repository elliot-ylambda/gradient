# Gradient — Claude Code plugin

A local setup checkup, distributed as a bundled runner and three skills:
`/gradient:optimize`, `/gradient:report`, and `/gradient:features`.

These SKILL.md files are the authored source. `make artifacts` generates the
Codex copies in `skills/gradient-*` with their own runner references.

Installing enables no hooks or background work. Node.js 20+ is required.
The checkup makes no model or network calls. Continuity returns a local checkpoint to the existing Claude session;
autopilot calls a separate configured model judge. Board and reports stay local.
Background hooks are opt-in per project
and currently implemented for Claude Code only.

See the [root README](../README.md) for installation, the checkup workflow,
compatibility, and data boundaries.
