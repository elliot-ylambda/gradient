---
name: gradient
description: Surface and apply gradient's automation suggestions for this project. Use when the user wants to find repeated Claude Code workflows or generate slash-commands, hooks, or loops from their history.
---

# gradient

`gradient` reads your Claude Code history, finds what you repeat, and generates
the automations to stop.

- `npx gradient scan` — read history, cluster repeats, propose automations (read-only)
- `npx gradient review` — inspect the ranked suggestions and their evidence
- `npx gradient apply <id>` — generate an approved artifact (command / loop / hook)
- `npx gradient list` / `remove <name>` — see and reverse what was generated

gradient only ever suggests and generates — you enable each artifact. Nothing
auto-schedules.
