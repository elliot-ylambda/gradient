---
name: scan
description: Find repeated Claude Code workflows in the user's own transcript history. Use when the user wants to mine their history, asks what they keep retyping, or wants automation suggestions.
---

Run the bundled gradient CLI (read-only — it only caches suggestions):

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" scan

- Default scope is this project's history. Add `--user` (all projects, recent
  window) or `--all` only when the user explicitly asks for cross-project results.
- Summarize the printed suggestions, then point the user at `/gradient:review`.
- If the command fails to start, the plugin install is broken — tell the user
  to reinstall the gradient plugin. Never fall back to a PATH-installed gradient.
