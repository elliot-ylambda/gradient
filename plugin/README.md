# gradient — Claude Code plugin

Installs the gradient CLI (bundled, no npm needed) and four skills:
`/gradient:scan`, `/gradient:review`, `/gradient:stats`, `/gradient:autopilot`.

**Installing this plugin runs nothing.** No hooks, no MCP servers, no settings
changes. Every automation gradient can set up (autopilot, session-start scans)
stays opt-in via its own command and is reversible.

Do not also run `gradient init --skill` (the npx flow's user-level skill) —
you'd get duplicate skills. Plugin users never need `init`: the bundled CLI
uses your existing `claude` auth by default.
