# gradient — Tool-Event Mining: the Assistant's Half of the Transcript — Design

**Date:** 2026-07-06
**Status:** Implemented (2026-07-18)
**Scope:** Spec 6. Extends mining input from user prompts to the session's
tool events (Bash commands and their failures, file-edit tools), adding two
detectors: **failure loops** and **post-edit rituals**. Builds on Spec 4
Phase A (classifier, skills emitter) and composes with Phase C's detect
window; requires neither Phase B nor D (integration with `insights` is
additive when D exists).

---

## 1. Context

The pipeline previously mined user prompts only. The transcripts already on
disk also record every tool call and result, and two high-value patterns live
exclusively there:

- **Failure loops.** The same command failing across sessions and days —
  the same test, the same build step — never appears in a user prompt
  unless the user happens to paste it. Spec 4 C1 catches *pasted* errors;
  failures Claude hits *inside* sessions are invisible to the entire
  current funnel.
- **Post-edit rituals.** Claude repeatedly running the same command after
  editing files (lint, typecheck, format). Community consensus is that a
  ritual that must always happen belongs in a `PostToolUse` hook, not in
  probabilistic instructions — but nobody notices the ritual forming.
  gradient can, and can hand over the deterministic hook.

This roughly doubles the mining surface at zero privacy cost: it is the
same local files, and only short command heads (never outputs beyond a
redacted first error line) can reach a model.

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope | **Failure loops + post-edit rituals.** Permission-denial mining stays excluded (Spec 4 Decision 8 — the built-in `/fewer-permission-prompts` owns that territory). |
| 2 | Input | **`parse.ts` gains an opt-in tool-event mode** (`parseToolEvents`) yielding compact `ToolEvent` records — Bash: command text, `is_error`, redacted first error line (≤120 chars); Edit/Write/NotebookEdit: file path only. Tool *outputs* beyond that first error line are never extracted. Default prompt-mining path unchanged. |
| 3 | Payload | **The `hook` payload generalizes**: `{ type: "hook"; event; description; matcher?; subcommand?; command? }` with **exactly one of `subcommand` \| `command`**. `subcommand` remains the gradient-owned form; `command` is a verbatim single-line shell command (≤200 chars, no newlines) mined from the user's own sessions. `review` renders the command verbatim before approval; nothing is ever auto-installed. |
| 4 | Artifact mapping | **Failure loops → `rule` or `skill`** (the value is the fix knowledge, and a hook can only inject context). **Rituals → `PostToolUse` hook** (`matcher: "Edit\|Write\|NotebookEdit"` — the same three tools the detector counts as edits — plus the mined command) — or a skill when the detect judge deems the command too slow to run on every edit (e.g. a full test suite). |
| 5 | Funnel integration | **New module `core/toolmine.ts`** producing `Candidate`s with kind hints `"toolfail"` and `"ritual"`. Like Phase C1's paste candidates they bypass trigram clustering and join the normal detect window, capped at ⌈window/3⌉ so prompt-derived candidates keep priority; anything dropped by the cap is logged (no silent caps). |
| 6 | Config | **`mineToolEvents?: boolean`, default `true`.** No new CLI flag. Per-session event cap (default 400) and a global cap (default 20,000) mirror `maxPrompts`, with drops reported. |
| 7 | Sharing with C1 | Failure-loop keying reuses C1's head-truncation idea. **Whichever lands second extracts the shared helper** (`commandHead()`), the plan of the later branch owns the refactor. |
| 8 | Dependencies | Zero new runtime dependencies; redaction runs before anything reaches an LLM, unchanged. |

## 3. Input: `ToolEvent`

```ts
export interface ToolEvent {
  ts: string;
  sessionId: string;
  kind: "bash" | "edit";        // edit = Edit | Write | NotebookEdit
  command?: string;             // bash only — first line, whitespace-collapsed, ≤1,000 chars
  isError?: boolean;            // bash only — from the paired tool_result
  errorHead?: string;           // bash only — first line of stderr/output, redacted, ≤120 chars
  file?: string;                // edit only — repo-relative path
}
```

- Extraction streams each transcript once, pairing `tool_use` with its
  `tool_result` by id; unpaired uses (interrupted turns) are skipped.
- Only the Bash tool and the three file-edit tools are extracted; MCP tools
  and everything else are ignored (v1).
- Caps (Decision 6) keep memory flat on large histories; the scan report
  lists dropped-event counts per scope, same style as the prompt cap.
- Bash command text is bounded during extraction, before it can enter the
  event list; detectors and model input still use only the shorter
  `commandHead()` described below.

## 4. Detector 1 — failure loops

- Key: `commandHead(command)` — first line, collapsed whitespace, truncated
  to ~80 chars. The same failing invocation shares its head even when error
  bodies differ (same property C1 exploits for pastes).
- A group becomes a candidate when **failures ≥ 3 across ≥ 2 sessions**
  (aligning C1's occurrence floor; exact constants pinned by fixtures).
- Candidate: `kind: "toolfail"`, `signature` = the head, `examples` = up to
  3 distinct `errorHead`s (already redacted). Sessions/counts as usual.
- Detect-prompt briefing for `toolfail` candidates: produce a **rule**
  ("before running X, ensure Y") when the evidence implies a stable
  precondition, else a **skill** ("run X; when it fails with Z, do W").
  Never a hook (Decision 4). Evidence lines in `review` show the command
  head and error heads — never full outputs.

## 5. Detector 2 — post-edit rituals

- For each `edit` event, examine the following ≤ 3 tool events in the same
  session; every Bash command found there is a *ritual observation* keyed by
  `commandHead`.
- A ritual becomes a candidate when (baseline; pinned by fixtures):
  **observations ≥ 15, sessions ≥ 3**, and the command follows at least
  ~40% of that project's edit windows — high absolute count alone is not
  enough; a ritual is defined by its *attachment to edits*.
- Candidate: `kind: "ritual"`, `signature` = the head.
- Detect-prompt briefing for `ritual` candidates: default to a
  `PostToolUse` hook payload `{ event: "PostToolUse", matcher:
  "Edit|Write|NotebookEdit", command: <head> }`; choose a skill instead
  when the command is plainly long-running (test suites, builds) — running
  those on every edit would be hostile.
- `review` for command-hooks renders: the event, the matcher, and the
  verbatim command, prefixed with a one-line warning that approving
  installs a hook that runs this command automatically after edits.

## 6. Validation & apply

- `validate.ts`: a `command` hook payload must be single-line, ≤ 200 chars,
  and non-empty; `matcher` (when present) must be a valid regex source.
  Exactly one of `subcommand` / `command` — anything else is rejected
  before it ever reaches `review`.
- `core/settings.ts#installHook` generalizes to accept `{event, matcher?,
  command}` alongside the existing gradient-subcommand form. Idempotent
  merge and the corrupt-settings refusal (Spec 1) are unchanged.
- `apply` installs both command and allowlisted gradient-subcommand hook
  payloads through the corrupt-refusing settings merge. `apply` is the
  explicit approval boundary; scan and review never install a hook.
- Manifest entries for command hooks record the full hook shape
  (`{event, matcher?, command}`) so `remove` uninstalls exactly what was
  added, via `removeHook`. Raw command hooks are additionally bound to the
  private approval ledger, preventing a forged repository manifest from
  claiming and removing an arbitrary user-owned settings entry.

## 7. `insights` integration (additive)

When Spec 4 Phase D exists, two rows join the metric table:

| Metric | Source | Paired recommendation |
|---|---|---|
| In-session failure loops | Detector 1 groups | the loop's rule/skill suggestion |
| Post-edit rituals | Detector 2 groups | the ritual's hook suggestion |

Without Phase D, `scan` prints a one-line summary per detector (count of
groups found). Neither direction is a dependency.

## 8. Explicitly out of scope (YAGNI)

- **Permission-denial mining** (Decision 1).
- **MCP tool events**, non-Bash executors, and tool *outputs* beyond the
  redacted first error line.
- **Success-sequence mining** ("after tests pass, user builds") — still the
  deferred sequence mining from Spec 2 §10.
- **Auto-installing any hook** — review/apply gating is unchanged.
- **`PostToolUseFailure` hooks for failure loops** — a context-injecting
  hook is the wrong artifact for fix knowledge (Decision 4); revisit only
  with evidence.

## 9. Sequencing & dependencies

Execute after Spec 4 Phase A merges (classifier + skills emitter + detect
wording — this spec extends the same detect prompt). Independent of Phases
B/D/E. Decision 7 governs the shared-helper refactor with Phase C1.

## 10. Dead code & outdated content (removed as part of execution)

- `core/types.ts` header comment *"The mining pipeline consumes only user
  text"* is rewritten — it becomes false the moment this ships.
- README "clusters repeated prompts locally" and `cli/README.md` "How it
  works" steps gain tool-activity wording.
- `detect.ts` prompt text listing candidate sources is replaced, not
  appended to — one authoritative briefing block.

## 11. Testing

- Parser: pairing by tool-use id; interrupted turns skipped; caps enforced
  and reported; only Bash/edit tools extracted.
- Keying: same command with different error bodies groups; different
  commands do not; sub-threshold groups produce nothing.
- Rituals: attachment ratio respected (frequent command *not* following
  edits produces no candidate); window boundary (4th event after an edit
  does not count).
- Payload validation: multi-line/oversized commands rejected; matcher regex
  validated; `subcommand`+`command` together rejected.
- Apply/remove round-trip for a command hook, including the idempotent
  settings merge and manifest tracking.
- End-to-end fixture: synthetic transcript with `npm test` failing 4× across
  2 sessions and `npm run lint` following 16 of 20 edits across 3 sessions →
  exactly one `toolfail` and one `ritual` candidate.
- Redaction: an `errorHead` containing a secret-shaped token is redacted
  before detect.

## 12. Open questions for the implementation plan

- Exact constants: ritual attachment ratio (~40%), observation floor (15),
  window size (3), per-session/global event caps — all pinned against a
  captured fixture from real history.
- Whether `commandHead` should strip volatile tokens (hashes, tmp paths)
  before truncation — measure grouping quality on real history first.
- Whether Edit-tool events need file-extension awareness for the matcher
  (e.g. rituals that only follow `.ts` edits → `matcher` stays `Edit|Write`
  in v1; note if evidence disagrees).
