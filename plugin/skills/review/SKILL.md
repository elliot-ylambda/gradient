---
name: review
description: Review and apply gradient's cached suggestions — the workflows mined from the user's own history. Use after a scan, or when the user asks what gradient suggested or wants to approve suggestions.
---

1. List the cached suggestions:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" review --json

2. Present each one: name, title, type, evidence count/sessions, confidence,
   and a one-line summary of what applying would write.
3. Let the user choose. **Never apply without an explicit user choice in this
   conversation.**
4. For each approved id:

       node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" apply <id>

5. Report exactly what was written (including the local settings path for an
   installed hook) or printed (loop lines). To undo any artifact later:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/gradient.mjs" remove <name>`.
