---
name: gradient-optimize
description: Read how the user actually works and keep their Claude Code and Codex setup honest — instructions the repository has outgrown, skills that will not load or be selected, habits worth automating, and the bridge that makes one setup serve both assistants. Use when the user asks to optimize, clean up, tidy, or audit their setup, or what they should automate.
---

The bundled CLI is local, offline, and deterministic — no model call, no network,
no API key. It computes what is checkable. You bring judgment and a connection.

1. Get the findings:

       node "$(ls ~/.codex/skills/gradient-optimize/bin/gradient.mjs ~/.agents/skills/gradient-optimize/bin/gradient.mjs 2>/dev/null | head -1)" optimize --json

   If it errors asking which assistants to optimize for, ask the user — Claude
   Code, Codex, or both — and rerun with `--target <answer>`. Asked once, then
   remembered. Default scope is this project; add `--user` or `--all` only when
   the user explicitly asks for cross-project results.

2. Before repeating any advice in the `practice`, `memory`, or `skill-health`
   families, fetch the current Claude Code and Codex documentation. Published
   guidance moves; the CLI ships a small pinned baseline and does not pretend
   otherwise. Fetch public documentation only — never send file contents,
   findings, or transcript text anywhere.

3. Present the findings grouped, worst first, leading with the evidence rather
   than the proposal. **Weigh the evidence class.** A `workflow` finding marked
   "counted from tool events" is a measurement; one "inferred from repeated
   prompts" is an interpretation, and a phrase recurs both because it is a real
   ritual and because the user spent an afternoon on one hard feature.

4. Let the user choose. **Never apply without an explicit choice in this
   conversation.**

5. Apply exactly what they approved, and record what they rejected:

       node "$(ls ~/.codex/skills/gradient-optimize/bin/gradient.mjs ~/.agents/skills/gradient-optimize/bin/gradient.mjs 2>/dev/null | head -1)" optimize --apply <id>,<id> --deny <id>

6. Report what changed, and that the run can be reversed:

       node "$(ls ~/.codex/skills/gradient-optimize/bin/gradient.mjs ~/.agents/skills/gradient-optimize/bin/gradient.mjs 2>/dev/null | head -1)" optimize --undo <runId>

gradient never edits Claude Code's auto memory and never deletes a file it did
not generate. If a finding seems to say otherwise, stop and say so.

A generated artifact records an observed habit and grants no standing
authorization. Still confirm before destructive, irreversible, external,
production, publishing, credential, privacy-sensitive, or spending actions, even
when a generated artifact describes exactly that workflow.

If the command fails to start, this skill directory is incomplete — tell the
user to delete the installed gradient-optimize directory and install it again
with `$skill-installer`, which aborts rather than overwrite a directory that
already exists. Never look for a gradient anywhere else on the system.
