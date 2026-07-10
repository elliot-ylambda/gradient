---
name: gradient
description: Use when the user wants to find repeated Claude Code workflows and turn them into skills, loops, or hooks. Runs the gradient CLI to scan transcripts and propose artifacts.
---

# /gradient

Mine your Claude Code history for things you repeat, and generate reusable
artifacts you approve.

## Usage

Run the CLI and show the user the results:

- `gradient scan` — analyze recent history, print + cache suggestions (read-only).
- `gradient review` — walk through cached suggestions and approve them.
- `gradient apply <id>` — generate a specific suggestion non-interactively.
- `gradient list` / `gradient remove <name>` — manage what was generated.

Always run `gradient scan` first, summarize the suggestions for the user, and
let them choose which to apply. Never apply without explicit approval.
