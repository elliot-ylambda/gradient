---
name: stats
description: Show the user's repeated Claude Code patterns, automation coverage, adoption, and local behavior insights. Use when the user asks how they use Claude Code or what gradient has covered.
---

Run and relay both local reports:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" stats
    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" insights

Highlight uncovered high-count patterns and suggest `/gradient:review` for them.
