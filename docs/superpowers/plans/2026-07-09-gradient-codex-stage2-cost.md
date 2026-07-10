# gradient — Codex Mining & Token-Aware Insights — Implementation Plan

**Date:** 2026-07-09  
**Spec:** `docs/superpowers/specs/2026-07-09-gradient-codex-and-cost-design.md`  
**Status:** In implementation

## Verified inputs

- Codex CLI 0.144 rollout files live under `~/.codex/sessions/YYYY/MM/DD/*.jsonl`.
- The first `session_meta` record supplies `id`, `cwd`, git branch/repository,
  and whether a rollout is a spawned subagent.
- Genuine prompts are `event_msg` records with `payload.type=user_message`.
  Older rollouts without those events fall back to `response_item` user
  messages; files containing both use events so prompts are never doubled.
- `token_count.info.total_token_usage.total_tokens` is cumulative. The parser
  attributes positive deltas to the current user turn, avoiding duplicate
  snapshots. Claude assistant usage records are accumulated the same way.
- Repository Codex skills use `.agents/skills`, per current Codex docs.

## Tasks

1. Add a metadata-only Codex collector, honoring project/all scope, recency,
   and excluding subagent rollouts.
2. Parse Codex JSONL into the existing `Turn`/dialogue shapes, with malformed
   line counts, source tags, collision-proof session IDs, and recorded usage.
3. Feed enabled assistant sources into one shared filtering/cap/clustering
   pipeline so exact and fuzzy evidence merges by signature.
4. Carry assistant provenance into candidate/suggestion evidence and show it
   only when an explanation spans both assistants.
5. Quantify nudge, continuation, and repeated-paste token cost in insights,
   using recorded usage when present and `ceil(chars/4)` otherwise.
6. Add a Codex CLI backend and dual-assistant `init` installation so a
   Codex-only user has the semantic judge and gradient skill without Claude.
7. Validate against fixtures, the full suite, and real local Claude/Codex
   history before release.

## Resolved open questions

- One `maxPrompts` budget is shared across assistants; recency, not source,
  decides what survives.
- Sources are weighted equally. A repeat is evidence regardless of which
  supported assistant recorded it.
- Tokens are reported, never dollars. Cached and uncached recorded tokens stay
  in the assistant's own total rather than applying a pricing model.
