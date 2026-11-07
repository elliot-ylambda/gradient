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

   `--apply` saves a restore point before the first change and prints each
   change as a diff; show that diff. Dismissals persist while the evidence is
   unchanged. Automatic/scheduled checks only propose; legacy `--auto` does not
   grant repair authorization.

4. When the user asks to tidy or rewrite their instruction files (CLAUDE.md,
   AGENTS.md, rules), or a length, duplicate, or Codex-budget finding calls for
   it, offer a guided rewrite. Save a restore point before touching anything:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" optimize --checkpoint

   Then propose a plan before editing: per file, what to cut, what to move
   where, and the target size. Edit only what the user approves. Every removed
   line must be stale (Gradient's evidence), duplicated (say where), or moved
   (say to which file); never drop a rule silently. Keep only what an agent
   could not work out by reading the code. Current official guidance (verify
   the pages before relying on them, as in step 2):
   - Claude Code (code.claude.com/docs/en/memory): keep each CLAUDE.md under
     ~200 lines, specific, under headers and bullets; contradictions are
     resolved arbitrarily, so remove them. Move instructions for one part of
     the codebase to `.claude/rules/*.md` with `paths:` frontmatter, and
     multi-step procedures to skills; both load only when needed. Every
     CLAUDE.md above the working directory loads at launch; `claudeMdExcludes`
     skips ones that do not apply. `/context all` lists what loaded, and
     `/doctor prompt-audit` has Claude check these files for outdated or
     conflicting instructions — offer it alongside Gradient's evidence.
   - Codex (learn.chatgpt.com/docs/agent-configuration/agents-md): AGENTS.md files are
     concatenated from the repository root down to the working directory, an
     `AGENTS.override.md` wins in its directory, and Codex stops adding text at
     `project_doc_max_bytes` (32 KiB by default). Raise that in
     `~/.codex/config.toml` or move detail into nested AGENTS.md files beside
     the code. Leave formatting and lint rules to the tools that enforce them.

5. Finish every session that changed anything by showing everything since the
   restore point, then verify with another checkup:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" optimize --changes

   Tell the user they can put all of it back — applies and hand edits alike —
   and that the restore itself prints a command to reverse it:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" optimize --restore

   `--undo <runId>` still reverses a single apply. If either reports a
   conflict or a file it could not restore, explain that the current content
   was kept. Do not claim restoration until it succeeds.

Optional feature status is context, not a reason to enable more automation.
Gradient currently installs hooks only for Claude Code; Codex has its own native
hook system. Never enable a background feature without the user's choice.

Gradient never changes assistant-managed auto memory. Generated workflows record
observed habits and grant no standing permission for consequential actions.

If the command fails to start, the plugin install is broken — tell the user to
reinstall the gradient plugin. Never fall back to a PATH-installed gradient.
