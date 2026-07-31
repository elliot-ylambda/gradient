---
name: scan
description: Find repeated Claude Code and Codex workflows in the user's own transcript history and install the ones they approve. Use when the user wants to mine their history, asks what they keep retyping, or wants automation suggestions.
---

Scanning sends bounded, redacted candidate snippets to the configured model.
Say so before running it.

1. Find and cache the proposals:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" scan --json

   Use `--json`; the bare form walks the proposals interactively and expects a
   terminal. Read the result as `{ projectPlaybook, suggestions }`. Surface the
   committed `gradient.md` pin state: `unpinned` or `changed` means the user
   must run the interactive walkthrough in a terminal before that prose can
   reach the judge.

   Default scope is this project. Add `--user` (all projects, recent window) or
   `--all` only when the user explicitly asks for cross-project results.

2. Present each suggestion: name, title, type, evidence, confidence, and one
   line on what applying would write. **Weigh the evidence class first.** A
   suggestion counted from tool invocations is a measurement; one read out of
   repeated prompt text is an interpretation, and a phrase recurs both because
   it is a real ritual and because the user spent an afternoon on one feature.

3. Let the user choose. **Never apply without an explicit choice in this
   conversation.**

4. For each approved id:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" apply <id>

5. Report exactly what was written — including the local settings path for an
   installed hook — or printed. To undo an artifact later:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" remove <name>

A generated artifact records an observed habit and grants no standing
authorization. Still confirm before destructive, irreversible, external,
production, publishing, credential, privacy-sensitive, or spending actions, even
when a generated artifact describes exactly that workflow.

If the command fails to start, the plugin install is broken — tell the user to
reinstall the gradient plugin. Never fall back to a PATH-installed gradient.
