# gradient — Personalized Auto-Responder (`autopilot`): Design

> **Amended 2026-07-03:** the playbook artifact was renamed to `gradient.md`
> and gained a per-project layer. See
> [`2026-07-01-gradient-md-design.md`](./2026-07-01-gradient-md-design.md).
> References to `playbook.md` below are preserved as the original record.

**Date:** 2026-07-01
**Status:** Implemented and released (`nudge`; arbitrary-response `full` is security-disabled)
**Scope:** Third sub-project of `gradient` — the phase-2 autopilot deferred from
the v1 spec (§1) and sequenced after Continuous Mining (Spec 1).

---

## 1. Context

v1 shipped the **analysis engine** (mine history → suggest artifacts); Spec 1
sharpened it (semantic dedup, `stats`/`explain`, session-start scan, LSH
scaling). Both are read-only advisors: they never act inside a session.

This spec ships the third capability from the original vision: an **LLM-driven
`Stop` hook that auto-responds** so the user stops manually nudging Claude.
The evidence is the strongest in the whole dataset — the v1 dogfooding run
found **~150 `continue` variants + ~23 "what's next?"**, the single most
repeated habit in 2,800+ transcripts. gradient already knows *how this user
nudges*; autopilot closes the loop by sending that nudge automatically.

"Personalized" is literal: the responder answers with **this user's own
phrasings and workflow knowledge**, mined by `scan`, not a generic
"continue" bot.

Mechanics recap (Claude Code `Stop` hook contract):

- Fires when the main agent finishes responding. Receives JSON on stdin:
  `{session_id, transcript_path, cwd, hook_event_name, stop_hook_active}`.
- Printing `{"decision":"block","reason":"<text>"}` cancels the stop and
  feeds `reason` to Claude as the next instruction.
- **Exit code 2 also blocks the stop and feeds stderr to Claude** — so a
  crashing hook accidentally becomes an instruction. `respond` must
  therefore trap everything and always exit 0.
- `stop_hook_active` is true when the session is already continuing because
  of a Stop hook. We deliberately do **not** bail on it — that flag being
  true just means our loop is working. Loop safety comes from the budget and
  progress gates (§3.2).

---

## 2. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Authority | **Config-driven mode ladder**: `off` / `nudge` / `full`. `nudge` may only push unfinished work forward; `full` may also answer routine questions and start the user's typical next step. User controls the mode. |
| 2 | Personalization | **Mined playbook + live judge.** `scan` writes an editable `playbook.md` (nudge phrasings, workflows, user rules); at each stop one LLM call applies it to the transcript tail. |
| 3 | Safety bounds | **Budget + progress check.** Per-session cap on auto-responses (default 10) AND a no-progress rule: if Claude stops again with no tool activity since our last nudge, stand down for the session. |
| 4 | Activation | **Dedicated command**: `gradient autopilot <off\|nudge\|full>` sets config and installs/removes the Stop hook; `gradient autopilot status` shows mode + recent decisions. |
| 5 | Decision architecture | **Gated single judge.** Free local gates first (recursion, mode, budget, progress); only then ONE LLM call on a fast model. At most one call per stop; fail-open. |
| 6 | Failure direction | **Fail-open, always**: any error → the stop stands. Autopilot's failure mode is "off", never "loops" or "blocks the session". |
| 7 | Hook rule (inherited from v1 #9) | The installed hook runs `gradient respond` — a small, tested subcommand, never inline shell. |

---

## 3. Components

### 3.1 Command surface (`commands/autopilot.ts`, `commands/respond.ts`)

- **`gradient autopilot <off|nudge|full>`** — writes `autopilot` mode to
  `~/.config/gradient/config.json`. On `nudge`/`full`: installs the `Stop`
  hook `gradient respond` into the project's `.claude/settings.json` via the
  existing `installHook`. On `off`: removes it via a new
  `removeHookFromSettings` (inverse of `mergeHookIntoSettings`; same
  refuse-to-touch-corrupt-file semantics; leaves other hooks untouched).
- **`gradient autopilot status`** (also bare `gradient autopilot`) — prints
  mode, budget, playbook path (and whether it exists), whether the hook is
  installed in this project, and the current session-state directory's most
  recent decision log entries ("what did it do while I was away").
- **`gradient respond`** — internal hook target (listed with `checkpoint` in
  HELP's internal section). Stdin → decision → stdout. Always exits 0.

New `Config` keys:

```ts
autopilot?: "off" | "nudge" | "full";   // absent = off
autopilotBudget?: number;                // max auto-responses/session, default 10
autopilotModel?: string;                 // judge model, default "haiku"
```

`autopilotModel` is separate from `model` (scan's) because the judge sits in
the user's stop path — latency matters more than depth; default to a fast
model alias the backend understands (`haiku`).

Scoping rule: the **mode is user-global** (config), the **hook is
per-project** (settings.json). Autopilot therefore acts only in projects
where the user ran `gradient autopilot nudge|full` — a global mode with no
local hook does nothing, and `off` removes only the current project's hook
while setting the global mode to `off`.

### 3.2 The `respond` pipeline (gates → judge)

All gates are local and free. Any gate failing → exit 0 silently (stop
stands):

1. **Recursion guard** — if env `GRADIENT_AUTOPILOT_CHILD` is set, exit.
   The judge is a headless `claude -p` spawn; if its own Stop hook fired it
   would re-enter `respond`. The guard breaks the chain; additionally the
   child is spawned with `cwd` = OS temp dir so it never loads the project's
   settings/hooks at all (belt and suspenders).
2. **Mode gate** — config `autopilot` absent or `off` → exit.
3. **Budget gate** — session state `count >= autopilotBudget` → exit.
4. **Progress gate** — compute a progress fingerprint from the transcript
   (count of `tool_use` blocks + total line count). If unchanged since our
   last auto-response, Claude stopped again without doing real work: record
   `stoodDown: true` in state and exit. A stood-down session stays stood
   down (no more nudges) until the user intervenes manually (their manual
   prompt advances the fingerprint and clears the flag).

Then the judge:

- **Tail rendering** (`core/tail.ts`, new): parse the transcript JSONL into a
  compact plain-text rendering of the last ~30 turns — user text, assistant
  text, and a one-line summary of tool activity per assistant turn (e.g.
  `[3 tool calls: Edit ×2, Bash]`). Capped at ~8k chars. This is a separate
  module from `parse.ts`, whose user-prompts-only contract stays intact for
  the mining pipeline; `parse.ts`'s "not until phase 2" comments get updated
  to point here (§9).
- **Redaction**: the rendered tail passes through the existing redaction
  utility before leaving the machine — same trust boundary as `scan`'s LLM
  calls.
- **One `LLMBackend.complete()` call** with system prompt = mode contract +
  playbook contents. Mode contracts:
  - `nudge`: *"Decide whether the work is actually done or Claude stopped
    early. If unfinished and not waiting on the user, reply with the nudge
    this user would send (use their phrasings). If Claude asked the user a
    genuine question, or the work is done → stand down."*
  - `full`: nudge contract, plus: *"You may answer routine questions and, when
    a task is complete, start this user's typical next step per the playbook.
    Stand down on anything irreversible or destructive (pushes, deploys,
    deletions, spending) unless the playbook's Rules explicitly allow it."*
- **Response schema** (strictly validated, `validate.ts` style):
  `{action: "continue" | "stand_down", response?: string, why: string}`.
  `action:"continue"` requires non-empty `response`. Malformed → fail-open.
- **Timeout**: internal 45s cap on the judge call (the installed hook entry
  sets `timeout: 60`); timeout → fail-open.

On `continue`: print `{"decision":"block","reason":<response>}`, update state
(`count+1`, new fingerprint, log entry `{ts, action, why, excerpt}`), exit 0.
On `stand_down`: log it, print nothing, exit 0.

### 3.3 The playbook (`core/playbook.ts`, written by `scan`)

`scan` gains a final step that renders `~/.config/gradient/playbook.md` from
data the pipeline already computed — no new mining pass:

- **How I nudge** (mined): loop-kind cluster signatures + example phrasings
  with counts (`"continue" ×150`, `"what's next?" ×23`, …).
- **My workflows** (mined): command suggestions with one-line descriptions
  (`/ship — push, open a PR, review it`, …) so `full` mode knows what "the
  usual next step" means.
- **Rules** (user-owned, editable): seeded once with safe defaults —
  *never green-light irreversible actions; stand down when a decision needs
  my judgment; prefer standing down over guessing.*

Regeneration replaces only the region between `<!-- gradient:mined:start -->`
and `<!-- gradient:mined:end -->` markers; everything outside (the Rules) is
preserved verbatim across rescans. If the file is missing, `respond` uses
built-in defaults — autopilot works before the first scan.

User-level location (not per-project) because habits are user-level, matching
where config lives.

### 3.4 Session state (`core/state.ts`)

`~/.config/gradient/state/<session_id>.json`:

```ts
{ count: number; lastFingerprint: string; stoodDown: boolean;
  log: { ts: string; action: "continue" | "stand_down"; why: string; excerpt: string }[] }
```

Log ring-buffered to the last 20 entries. Each `respond` run opportunistically
deletes state files older than 7 days. Corrupt state file → treated as fresh
(counts reset) — worst case the budget restarts, still bounded.

### 3.5 Backend spawn options (`llm/claudeCli.ts`)

`ClaudeCliBackend` gains constructor deps `{ spawnCwd?: string; extraEnv?:
Record<string,string> }` threaded into its `RunFn`, so `respond` can spawn the
judge with the temp-dir cwd and the `GRADIENT_AUTOPILOT_CHILD=1` guard env.
The Anthropic SDK backend needs neither (no subprocess, no hooks).

### 3.6 Scan cross-link

When `review`/`list` display a **loop-kind suggestion that matches a nudge
pattern** (same normalized signature as a playbook nudge entry), append a
hint line: `tip: this is what autopilot automates → gradient autopilot nudge`.
Display-only; loop suggestions themselves are unchanged.

---

## 4. Data-model deltas

- `Config` + `autopilot`, `autopilotBudget`, `autopilotModel` (§3.1).
- New `SessionState` interface (§3.4) in `core/types.ts`.
- New `TailTurn`/tail rendering types local to `core/tail.ts` (assistant
  turns stay out of the mining `Turn` type on purpose).
- No changes to `Suggestion`, `Candidate`, manifest, or cache formats.

---

## 5. Data flow

```
Claude Code stops
  └─ Stop hook: gradient respond   (stdin: session_id, transcript_path, …)
       ├─ gates: recursion → mode → budget → progress   (any fail → exit 0)
       ├─ tail.ts: transcript → compact tail → redact
       ├─ judge: LLMBackend.complete(mode contract + playbook + tail)
       │     └─ claude-cli backend: spawn cwd=tmp, env GRADIENT_AUTOPILOT_CHILD=1
       ├─ continue  → stdout {"decision":"block","reason":…} + state update
       └─ stand_down → log, print nothing
gradient scan (existing pipeline)
  └─ playbook.ts: clusters/suggestions → playbook.md (mined regions only)
gradient autopilot <mode>
  └─ config write + installHook/removeHookFromSettings on .claude/settings.json
```

---

## 6. Error handling & guardrails

- **Exit-code discipline**: `respond`'s entire body runs inside a catch-all;
  it never exits non-zero and never writes to stderr on the failure path,
  because exit 2 + stderr would be injected into Claude as an instruction.
- **Fail-open inventory** (each → stop stands): unreadable/corrupt config,
  state, or playbook; transcript missing or unparseable; backend unavailable;
  judge timeout (45s); malformed/oversized judge response; JSON stdout write
  failure.
- **Permissions unchanged**: the judge's reply is only an instruction; Claude
  still runs under the user's permission mode, so dangerous tools still
  prompt the user. `full` mode cannot bypass permission prompts even in
  principle (hooks cannot answer them).
- **Budget + progress + stood-down latch** are the loop protection;
  `stop_hook_active` is intentionally not used as a gate (§1).
- **Trust surface**: activation only via the explicit `autopilot` command;
  every decision logged and visible via `gradient autopilot status`.

---

## 7. Privacy

The transcript tail is redacted with the existing redaction utility before
the judge call, and the call goes through the same user-configured
`LLMBackend` (their own Claude auth or API key) that `scan` already uses —
no new data leaves the machine beyond what `scan` already sends, except that
tails include **assistant** text for the first time; redaction therefore runs
on the full rendered tail, not just user turns.

---

## 8. Testing

House style: every unit takes injected deps; no network, no real `claude`.

- **Gates**: each gate isolated with fixture stdin/config/state — recursion
  env set; mode off/absent; budget exactly at/above cap; fingerprint unchanged
  vs advanced; stood-down latch persists and clears on user activity.
- **tail.ts**: fixture transcript JSONL (user turns, assistant text blocks,
  tool_use blocks, sidechains) → expected compact rendering, cap enforced,
  fingerprint counts correct.
- **Judge integration** (fake backend): continue path emits exact block JSON;
  stand-down emits nothing; malformed JSON, empty `response` with
  `action:"continue"`, timeout, backend error — all end with stop standing.
- **respond end-to-end** (tmp dirs, fake backend): full happy path updates
  state correctly; every failure path exits 0 with empty stdout.
- **autopilot command**: mode round-trips through config; hook
  installed/removed correctly incl. corrupt-settings refusal and
  preservation of unrelated hooks.
- **playbook.ts**: generation from fixture suggestions; regeneration
  replaces mined region only; user Rules edits survive; missing playbook →
  defaults used.
- **claudeCli spawn opts**: `spawnCwd`/`extraEnv` reach the spawned process
  (via injected RunFn capture).

---

## 9. Code removed / rewritten (cleanup discipline)

- `parse.ts` header comment and `Turn` doc comment ("assistant turns …
  intentionally not parsed until phase 2") are **now stale** — rewrite both
  to point at `core/tail.ts` as the assistant-turn consumer.
- `settings.ts` grows the remove path; no existing code becomes dead.
- No suggestion/emit code is removed: loop suggestions remain valid artifacts
  (the §3.6 hint is display-only).
- Follow-up outside this repo (not in this spec): landing-page trust copy
  ("nothing runs behind your back") must be revised when autopilot ships,
  as done for `--session-scan` in Spec 1.

---

## 10. Out of scope (YAGNI)

- **Sequence mining** ("what the user does right after completions") — the
  editable Rules section covers it manually; revisit with evidence.
- **User-level (global) hook install** — per-project only, like session-scan.
- **Answering permission prompts** — impossible via hooks, and undesirable.
- **Desktop notifications** on stand-down; **daemon/watch** mode; **MCP**;
  **local LLM** backend; **multi-assistant** support (all still deferred).
- **Per-project playbooks / playbook overrides** — one user-level file.

---

## 11. Open questions for the implementation plan

- Exact tail size (turns vs chars) pinned against judge-model context and
  latency measurements.
- Whether `status` reads the newest state file or takes an explicit
  `--session <id>`; default behavior to be fixed in the plan.
- The precise fingerprint function (tool_use count + line count is the
  baseline; the plan may add last-assistant-message hash if tests show
  false "progress" positives).
