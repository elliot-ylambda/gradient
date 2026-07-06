# gradient — `gradient.md`: the branded playbook file — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming complete; implementation plan pending)
**Scope:** Amendment to Spec 2 (Personalized Auto-Responder). Renames the
autopilot playbook artifact to `gradient.md`, adds a per-project layer, and
defines how the two layers compose. Applies on top of the merged Spec 2
implementation on `main` — the rename is free because `playbook.md` has never
been published (no npm release yet).

---

## 1. Context

The autopilot playbook currently lives at `~/.config/gradient/playbook.md`
(Spec 2 §3.3): a mined region refreshed by `scan` plus a user-owned Rules
section, read by the `respond` judge at every stop. It is user-global and
invisible — nobody sees it unless they go looking.

Meanwhile the project already brands the domain `gradient.md` (README).
Naming the artifact `gradient.md` closes the loop: the product, the domain,
and the file share one name — the same artifact-as-brand move that made
CLAUDE.md recognizable.

The name is defensible because the file's role does not overlap CLAUDE.md /
AGENTS.md:

- **CLAUDE.md speaks to the agent, during a session, about the project.**
  **gradient.md speaks to the automation layer *around* the session, about
  the operator** — how the user nudges, what they'd approve, when to stand
  down. Claude Code never reads it; gradient's Stop-hook judge does.
- The distinction is mechanical, not positioning: "when I stop, nudge me"
  written in CLAUDE.md does nothing, because Claude is not running at
  stop-time. Only a hook is. gradient.md configures code that runs when the
  agent isn't.
- It is the only file in this ecosystem that is **bidirectional**: CLAUDE.md
  is human→agent; gradient.md is machine-mined *and* human-edited, with the
  marker-region splice making co-ownership safe.

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope | **Layered, like CLAUDE.md.** Personal file at `~/.config/gradient/gradient.md` (renamed from `playbook.md`); optional committed file at `<repo>/gradient.md` holding the repo's automation contract. |
| 2 | Project-file authorship | **Suggest-only.** `scan` never auto-writes the committed file — mined content comes from personal transcripts (evidence counts are personal telemetry) and gradient's core promise is "only ever suggests". Hand-authored now; `gradient apply` writes approved project-level suggestions later (deferred, §6). The global file keeps its auto-refreshed mined region. |
| 3 | Composition | **Clamp, never escalate.** A committed file is writable by anyone who can merge a PR; if it could raise autopilot authority, a teammate's (or attacker's) commit could silently escalate what local automation does on the user's machine. Effective mode = `min(global, project max-mode)` on the `off < nudge < full` ladder; effective budget = `min` of the two; prose rules from both files reach the judge. Repo maintainers can restrict automation, never expand it. |
| 4 | Malformed clamps | **Fail to `off`.** Unparseable frontmatter clamps to `off` for that repo — consistent with Spec 2 Decision 6 (failure mode is "off", never "more authority than intended"). The clamp gate stays free and silent (no per-session state writes on the hot path, no per-stop log spam); the malformed fact is surfaced by `gradient autopilot status`, which recomputes the effective mode for the current repo. Note the direction: judge/spawn errors fail *open* (the stop stands, autopilot does nothing); clamp-parse errors fail *closed* (autopilot off). Both resolve to "no action", never to escalation. |
| 5 | Vocabulary | **"Playbook" is the concept; "gradient.md" is the artifact.** Code symbols (`loadPlaybook`, `buildJudgePrompt`'s playbook param) and prose keep the noun; every user-facing surface (paths, template header, CLI output, docs) says `gradient.md`. |
| 6 | Migration | **None.** `playbook.md` exists only on the author's machine (no npm release yet); a one-time manual `mv` suffices. No fallback-read code. |

## 3. Files

| File | Owner | Role |
|------|-------|------|
| `~/.config/gradient/gradient.md` | User (personal) | Mined region (`<!-- gradient:mined:* -->`) + user Rules. Auto-refreshed by `scan`; `generatePlaybook`'s markers-gone → `null` contract unchanged. |
| `<repo>/gradient.md` | Team (committed) | Automation contract for the repo: frontmatter clamps + prose rules/workflows. Read from the Stop hook's `cwd`. |

### Project file format

Markdown with optional frontmatter for the machine-readable clamps;
everything else is prose for the judge:

```markdown
---
autopilot:
  max-mode: nudge   # ceiling in this repo: off | nudge | full
  budget: 5         # max auto-responses per session here
---
## Rules
- Never push, deploy, or publish from autopilot in this repo.
## Workflows
- After tests pass, the typical next step is `npm run build`.
```

- Frontmatter absent → no clamping; the file is prose-only judge context.
- Recognized keys: `autopilot.max-mode`, `autopilot.budget`. Unknown keys are
  ignored (forward compatibility). Each clamp applies independently — an
  absent key clamps nothing (e.g. `max-mode` without `budget` caps only the
  mode).
- Parsed by a small lenient line-based parser (~20 lines) in
  `core/playbook.ts`. No new dependency — the CLI has exactly one runtime
  dependency and stays that way.
- Malformed frontmatter (unopened/unclosed delimiters, unrecognizable values
  for known keys) → clamp to `off` (Decision 4). The `respond` clamp gate
  exits silently in this case; `autopilot status` reports it.

## 4. Composition in the `respond` pipeline

Ordering within Spec 2 §3.2's gate chain:

1. Recursion guard, mode gate — unchanged.
2. **New: project clamp.** Load `<cwd>/gradient.md` (cwd comes from the hook
   stdin JSON; a missing cwd means the clamp can't be checked, so the stop
   stands — never "act unclamped"). Missing file → no clamp. Effective mode =
   `min(config mode, project max-mode)`; if `off`, exit silently. Effective
   budget = `min(config autopilotBudget, project budget)` feeding the
   existing budget gate.
3. Budget gate, progress gate, tail render, redaction — unchanged, except
   the project file's prose also passes through the redaction pass
   (committed content shouldn't hold secrets, but the pass is cheap) and is
   capped at 4,096 chars before prompting.
4. **Judge prompt** gains provenance labels:

   ```
   PROJECT PLAYBOOK (this repo):
   <project gradient.md prose>

   YOUR PLAYBOOK:
   <global gradient.md>
   ```

   The system prompt's "unless the playbook's Rules explicitly allow it"
   becomes "unless both playbooks allow it" — prose rules union; the judge
   needs no merge logic beyond reading both.

## 5. Deltas (on `main`, post-Spec 2 merge)

- `core/playbook.ts` — `playbookPath()` → `.../gradient.md`; new
  `projectPlaybookPath(cwd)`, `loadProjectPlaybook(cwd)` (content + parsed
  clamps), clamp parser; `DEFAULT_PLAYBOOK` header →
  `# gradient.md — autopilot playbook`.
- `core/judge.ts` — `buildJudgePrompt` accepts global + project playbooks
  and emits the provenance-labeled prompt; system-prompt wording per §4.
- `commands/respond.ts` — project-clamp step in the gate chain; passes both
  playbooks to the judge.
- `commands/autopilot.ts` / `cli.ts` — `status` shows both paths, whether
  each exists, and the *effective* (clamped) mode in the current repo.
- `commands/scan.ts` — log line becomes `gradient.md updated → <path>`.
- Docs — README (2 playbook refs) updated to say `gradient.md`. The Spec 2
  doc and the auto-responder plan are dated historical records of executed
  work: they get a one-line amendment note at the top pointing here, not a
  rewrite of their 83 combined references. Tests updated alongside each code
  file.

### No leftovers

After execution nothing user-facing may say `playbook.md`: the
`DEFAULT_PLAYBOOK` template text, CLI help/status output, scan log lines,
and the README are in scope. Dated specs/plans are historical records and
keep their original wording (plus the amendment note). Code symbols keeping
the "playbook" noun (Decision 5) are deliberate, not leftovers.

## 6. Deferred (recorded, not built)

- **`gradient apply` → project gradient.md**: a new suggestion payload type
  for project-level rules/workflows, written into the committed file only
  after `review` approval. Next increment after this lands.
- **Domain-serves-template**: `https://gradient.md` serves the canonical
  default template so `curl -O https://gradient.md` is onboarding. Marketing
  surface, outside the CLI.

## 7. Testing

- Clamp parser: absent / valid / malformed frontmatter; unknown keys
  ignored; malformed → `off`.
- Composition: mode and budget min-rules across the
  `off`/`nudge`/`full` × absent/present matrix; missing project file → no
  clamp.
- Judge prompt: provenance labels present; project prose capped and
  redacted.
- Rename: `playbookPath` points at `gradient.md`; template header updated;
  scan log wording; `status` shows effective mode.
