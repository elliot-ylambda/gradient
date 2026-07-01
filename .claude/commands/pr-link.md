---
description: "PR link"
---
Output the URL of the GitHub pull request for the current branch. Run `gh pr view --json url -q .url`. If no PR exists for the branch, say so and offer to open one with `gh pr create`. Return just the URL as a clickable link — no extra commentary.
