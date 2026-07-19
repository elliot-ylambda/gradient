---
autopilot:
  max-mode: nudge   # ceiling for this repo: off | nudge | full
  budget: 5         # auto-responses per session
---

# gradient.md

The automation contract for this repo. `gradient`'s own Stop-hook auto-responder
reads this file; Claude Code does not. Project-level instructions for the agent
itself belong in `CLAUDE.md`.

The frontmatter above **clamps** autopilot for anyone working here. It can only
lower authority, never raise it: if your global mode is `full`, it drops to
`nudge` in this repo; if your global budget is 10, it drops to 5. Comments are
descriptive — the parser strips them.

## Rules

- Never push, deploy, publish, or open a PR from autopilot. `npm publish` is
  especially off-limits: the `gradient` name on npm belongs to an unrelated
  package, so publishing would be wrong in a way that is hard to undo.
- Never commit directly to `main`. Work on a branch.
- Never green-light a destructive git operation — `reset --hard`, `branch -D`,
  force-push, remote branch deletion. Stand down and let me run it.
- If tests are red, the work is not done. Say so rather than moving on.
- When a design decision has more than one defensible answer, stand down and
  ask. Prefer standing down over guessing.

## Workflows

- This is a TDD repo. The next step after a failing test is the minimal code to
  pass it — not a larger design. Write the test first, watch it fail, then
  implement.
- The build and test loop is `cd cli && npm test`, and `npm run build` before
  claiming a CLI change works. A change to `cli/src/` is not verified until the
  suite is green.
- Specs live in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`.
  A spec is written and approved before its plan; a plan before its code.
- After code changes land, the typical next step is running the full suite and
  then reviewing the diff against `main` — not starting the next feature.
