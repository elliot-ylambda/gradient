---
name: gradient
description: Use when the user wants to find repeated Claude Code or Codex workflows and turn them into skills, rules, loops, or hooks. Runs the gradient CLI to scan local transcripts and propose artifacts.
---

# gradient

Mine your Claude Code and Codex history for things you repeat, and generate reusable
artifacts you approve.

## Usage

Run the CLI and show the user the results:

- `gradient scan` — analyze history, send bounded/redacted candidates to the configured model, and cache suggestions.
- `gradient review` — walk through cached suggestions and approve them.
- `gradient apply <id>` — generate a specific suggestion non-interactively.
- `gradient list` / `gradient remove <name>` — manage what was generated.

Always explain that candidate snippets leave the machine, run `gradient scan`,
summarize the suggestions, and let the user inspect the exact preview before
choosing what to apply. Never apply without explicit approval.
