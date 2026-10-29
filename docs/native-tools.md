# Gradient and the assistants' native tools

Reviewed against official documentation on **October 28, 2026**. Features and
availability can vary by client and version. These are overlapping capabilities,
not claims that Gradient is the only tool able to do something.

Gradient's scope is a local checkup: inspect concrete instruction and skill
configuration, show the evidence, apply a chosen change, verify, and undo. It
combines observations across Claude Code and Codex without a model call.

| Need | Prefer the native capability | Gradient's role |
|---|---|---|
| Understand recent Claude sessions | `/insights` | Provide locally checkable findings across both assistants |
| Diagnose Claude setup or instruction problems | `/doctor`, including prompt audit | Identify specific missing paths and loading discrepancies |
| Evaluate Claude skills | `/skill-doctor`, skill-creator and plugin evaluations | Inventory and compatibility evidence; do not equate absent observed use with uselessness |
| Review or simplify code | Claude `/code-review` or `/simplify`; Codex `/review` | No competing code-review engine |
| Create a reusable workflow | The assistant's skill creator and evaluation tools | Supply reviewed recurrence evidence, not a generic wrapper for every repeated phrase |
| Remember prior work | Claude auto memory; Codex memories | Read-only observations; never edit generated memory |
| Schedule work | Native scheduled tasks or `/loop` where appropriate | A checkup can be the scheduled task; no new scheduling service |
| React to lifecycle events | Native Claude or Codex hooks | Existing Gradient hook installer is currently Claude-only |
| Reduce approval interruptions | Native permission configuration and approval review | Do not turn past approvals into standing authorization |

## Current compatibility details

Claude Code can load `AGENTS.md` directly when no applicable `CLAUDE.md` or
`CLAUDE.local.md` takes precedence. Its **Project instructions** mode, configured
in user settings through `pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles`,
can change that behavior. An explicit import is still useful for some mixed configurations;
its absence alone does not prove that instructions are missing.

Codex instruction precedence includes `AGENTS.override.md`, `AGENTS.md`, and
configured fallback names from the repository root to the current directory.
Skill discovery includes `.agents/skills` along that hierarchy, user/admin/system
locations, and plugins. The official skill installer also uses `$CODEX_HOME/skills`;
Gradient supports that installed compatibility location.

Claude's skill extensions and fallback behavior differ from the portable Agent
Skills format. A missing description or unfamiliar frontmatter field is not
universal proof that a skill fails to load. Describe the actual compatibility
observation and confirm it before changing a working skill.

Both assistants offer native hooks now. Gradient's current Claude-only hook
support describes this project's implementation, not a Codex limitation.

## Primary sources

- [Claude commands: insights, review, simplify, batch](https://code.claude.com/docs/en/commands)
- [Claude skills, diagnostics, and evaluation](https://code.claude.com/docs/en/skills)
- [Claude memory and instruction loading](https://code.claude.com/docs/en/memory)
- [Claude scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)
- [Codex skill discovery and creation](https://learn.chatgpt.com/docs/build-skills)
- [Codex instruction precedence](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Codex hooks and trust](https://learn.chatgpt.com/docs/hooks)
- [Codex scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)
- [Codex memories](https://learn.chatgpt.com/docs/customization/memories)
- [Codex automatic approval review](https://learn.chatgpt.com/docs/sandboxing/auto-review)
- [Codex notification configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)

## What would establish useful results

A reproducible check/fix/verify/undo fixture proves mechanics. A real user who
accepts a correct finding and benefits from the change establishes usefulness.
Neither transcript volume, passing unit tests, nor a typing-speed estimate is a
measurement of productivity gained. Keep these evidence levels separate.
