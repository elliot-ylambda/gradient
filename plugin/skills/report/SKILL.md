---
name: report
description: Read Gradient's local report of observed Claude Code and Codex activity, generated artifacts, and project feature state. Use when the user asks what Gradient has found or how their observed workflow has changed.
---

Run the bundled report. It reads local state and needs no prior scan:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs"

Lead with what is actionable. Explain that input limits bound the observation:
zero observed uses is not proof an artifact is useless, and estimated effort is
not measured time or tokens saved. Tool-event counts and inferred prompt patterns
are different evidence classes. Do not recommend removing a skill solely because
this report observed no invocation.

For setup fixes, use the optimize skill. Recommend native diagnostics, skill
creators, memory, review, and scheduled tasks before adding overlapping tools.
Gradient's optional hooks currently run only in Claude Code. Status applies to
the current repository; never enable a feature without the user's choice.

Add `--user` only for an explicit cross-project request. `--html` writes a private
local report. Reports, board, and the setup checkup stay local and offline.

If the command fails to start, the plugin install is broken — tell the user to
reinstall the gradient plugin. Never fall back to a PATH-installed gradient.
