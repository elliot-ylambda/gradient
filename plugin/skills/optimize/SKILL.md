---
name: optimize
description: Check Claude Code and Codex setup for stale instructions, skill configuration problems, and recurring habits. Show local evidence and apply only the fixes the user chooses. Use for a Gradient checkup or a setup audit.
---

Run a local checkup. The bundled runner needs Node.js 20+, makes no model or
network call on this path, and does not require an API key.

1. Get the findings:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" optimize --json

   If targets are not configured, ask which assistants to inspect — Claude
   Code, Codex, or both — and rerun with `--target <answer>`. Project scope is
   the default. Use `--user` or `--all` only for an explicit cross-project request.

2. Lead with a few concrete, useful findings and their evidence. Distinguish
   applicable fixes from review-only observations. Missing observed usage is
   not proof a skill was never used. A repeated prompt is not proof a new skill
   would help. State history limits and any inspection gaps.

   For product guidance in `practice`, `memory`, or `skill-health`, verify the
   relevant current official docs before advising a change. Fetch only public
   documentation; never send local findings or transcript content to a website.
   Prefer native tools when they solve the need: Claude's `/doctor`, `/insights`
   and `/skill-doctor`; each assistant's skill creator, memory, review, hooks,
   and scheduled tasks. Claude can load AGENTS.md directly in supported setups;
   do not assume a bridge is always needed.

3. Let the user choose. Never apply without an explicit choice in this
   conversation. Offer `pagePath` for a private local review page. The page
   distinguishes fixes from observations and builds a command from selections.
   A review-only finding needs judgment; do not claim `--apply` can fix it.

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" optimize --apply <id>,<id> --deny <id>

   Dismissals persist while the evidence is unchanged. Automatic/scheduled
   checks only propose; legacy `--auto` does not grant repair authorization.

4. Verify the result with another checkup, report changed files and any skips,
   and provide the undo command for the applied run:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" optimize --undo <runId>

   If undo reports a conflict, explain that later edits were preserved. Do not
   claim restoration until it succeeds.

Optional feature status is context, not a reason to enable more automation.
Gradient currently installs hooks only for Claude Code; Codex has its own native
hook system. Never enable a background feature without the user's choice.

Gradient never changes assistant-managed auto memory. Generated workflows record
observed habits and grant no standing permission for consequential actions.

If the command fails to start, the plugin install is broken — tell the user to
reinstall the gradient plugin. Never fall back to a PATH-installed gradient.
