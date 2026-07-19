---
name: stats
description: Show the user's most-repeated Claude Code patterns and how much is already automated. Use when the user asks how they use Claude Code or what gradient has covered.
---

Run and relay:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" stats

Highlight uncovered high-count patterns and suggest `/gradient:review` for them.
