# gradient — Claude Code plugin

Installs the gradient runner (bundled — no npm, no PATH, no global install) and
three skills: `/gradient:optimize`, `/gradient:report`, `/gradient:features`.

These three `SKILL.md` files are the authored source for both shipping shapes;
`skills/gradient-*` in the repository root is generated from them for Codex,
which has no plugin marketplace.

**Installing this plugin runs nothing.** No hooks, no MCP servers, no settings
changes. Every automation gradient can set up stays opt-in behind the `features` skill,
and is reversible.

The bundled CLI makes no network calls and needs no API key. Only autopilot's
Stop-hook judge calls a model, and only after you turn it on for a project.
