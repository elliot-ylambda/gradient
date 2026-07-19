# gradient skills

Reusable, open-standard skills for Claude Code and Codex. Each skill has one canonical `SKILL.md`; the installer links that same source into each assistant's discovery directory.

## Available skills

### vibe-security-check

Audit a rapidly built web or SaaS application for the security guards that AI-generated features commonly omit. It includes a ten-check launch-blocker pass based on two practitioner writeups, plus a broader baseline for secrets, sessions, input handling, payments, webhooks, uploads, dependencies, logging, and production configuration.

[Read the skill](vibe-security-check/SKILL.md) · [Review the full checklist](vibe-security-check/references/checklist.md)

Install it globally for both assistants:

```bash
npx skills add elliot-ylambda/gradient --skill vibe-security-check -g -a claude-code -a codex
```

Then invoke it explicitly:

```text
# Claude Code
/vibe-security-check Audit this app before launch.

# Codex
$vibe-security-check Audit this app before launch.
```

Both assistants implement the [Agent Skills open standard](https://agentskills.io). For a manual project install, copy the skill directory to `.claude/skills/vibe-security-check` for Claude Code or `.agents/skills/vibe-security-check` for Codex.

## Design rules

- Keep the shared workflow assistant-neutral; do not use Claude-only frontmatter or Codex-only tool names in `SKILL.md`.
- Put detailed, selectively loaded guidance in `references/`.
- Include only `name` and `description` in shared skill frontmatter.
- Validate each skill before publishing and test it against a realistic repository.
