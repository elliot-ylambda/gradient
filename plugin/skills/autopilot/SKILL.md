---
name: autopilot
description: Turn the autopilot feature on or off — the opt-in Stop hook that answers routine nudges the way the user would.
disable-model-invocation: true
---

Autopilot authority is the user's decision; this skill only runs the exact
subcommand they asked for:

    node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" autopilot <status|nudge|off>

- No argument given → run `status` and explain the modes: `nudge` pushes
  unfinished work forward, bounded by a per-session budget and a progress
  gate; `off` removes the hook. (`full` is disabled pending additional
  security hardening.)
- Never choose a mode for the user.
