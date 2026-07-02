import { tmpdir } from "node:os";
import type { Config } from "../core/types.js";
import { loadConfig, DEFAULT_AUTOPILOT_BUDGET, DEFAULT_AUTOPILOT_MODEL } from "../config.js";
import { loadState, saveState, cleanupStale } from "../core/state.js";
import { renderTail, fingerprint, readTranscriptLines } from "../core/tail.js";
import { loadPlaybook } from "../core/playbook.js";
import { buildJudgePrompt, judge } from "../core/judge.js";
import { redact } from "../core/security.js";
import { selectBackend } from "../llm/index.js";
import { ClaudeCliBackend } from "../llm/claudeCli.js";
import { AnthropicBackend } from "../llm/anthropic.js";
import type { LLMBackend } from "../llm/backend.js";

export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean; // intentionally unused as a gate (spec §1): budget + progress are the loop protection
}

export interface RespondResult {
  decision: "allow" | "block";
  reason?: string;
}

export interface RespondDeps {
  config?: Config;
  backend?: LLMBackend | null;
  readLines?: (path: string) => Promise<string[]>;
  home?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => string;
}

/** The claude CLI accepts the "haiku" alias; the Anthropic API needs a real model ID. */
export const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
};

async function autopilotBackend(config: Config): Promise<LLMBackend | null> {
  const model = config.autopilotModel ?? DEFAULT_AUTOPILOT_MODEL;
  return selectBackend({
    config,
    candidates: [
      // Neutral cwd + guard env: the headless child must never re-enter this hook.
      new ClaudeCliBackend({ model, spawnCwd: tmpdir(), extraEnv: { GRADIENT_AUTOPILOT_CHILD: "1" } }),
      new AnthropicBackend({ model: ANTHROPIC_MODEL_ALIASES[model] ?? model }),
    ],
  });
}

/**
 * The Stop-hook pipeline: free local gates, then one judge call.
 * NEVER throws — every failure path resolves to {decision:"allow"} so the
 * stop stands (spec §6). The caller must still exit 0 unconditionally.
 */
export async function respond(input: StopHookInput, deps: RespondDeps = {}): Promise<RespondResult> {
  const allow: RespondResult = { decision: "allow" };
  try {
    // Gate 1: recursion guard.
    const env = deps.env ?? process.env;
    if (env.GRADIENT_AUTOPILOT_CHILD) return allow;

    // Gate 2: mode.
    const config = deps.config ?? (await loadConfig(deps.home));
    const mode = config.autopilot;
    if (mode !== "nudge" && mode !== "full") return allow;
    if (!input.session_id || !input.transcript_path) return allow;

    void cleanupStale(deps.home).catch(() => {}); // opportunistic, never awaited on the hot path

    // Gate 3: budget.
    const state = await loadState(input.session_id, deps.home);
    const budget = config.autopilotBudget ?? DEFAULT_AUTOPILOT_BUDGET;
    if (state.count >= budget) return allow;

    // Gate 4: progress. Fingerprint is tool-activity only (see tail.ts).
    const lines = await (deps.readLines ?? readTranscriptLines)(input.transcript_path);
    const fp = fingerprint(lines);
    if (state.stoodDown) {
      if (fp === state.lastFingerprint) return allow; // still latched
      state.stoodDown = false; // real work happened since — latch clears
    }
    if (state.lastFingerprint !== "" && fp === state.lastFingerprint) {
      state.stoodDown = true; // stopped again with zero new tool activity: don't nudge into a wall
      await saveState(input.session_id, state, deps.home);
      return allow;
    }

    const backend = deps.backend !== undefined ? deps.backend : await autopilotBackend(config);
    if (!backend) return allow;

    const tail = redact(renderTail(lines));
    const playbook = await loadPlaybook(deps.home);
    const decision = await judge(backend, buildJudgePrompt(mode, playbook, tail), { timeoutMs: deps.timeoutMs });

    const ts = (deps.now ?? (() => new Date().toISOString()))();
    state.lastFingerprint = fp; // recorded on every decision: identical transcripts are never re-judged
    if (decision.action === "continue" && decision.response) {
      state.count += 1;
      state.log.push({ ts, action: "continue", why: decision.why, excerpt: decision.response.slice(0, 120) });
      await saveState(input.session_id, state, deps.home);
      return { decision: "block", reason: decision.response };
    }
    state.log.push({ ts, action: "stand_down", why: decision.why, excerpt: "" });
    await saveState(input.session_id, state, deps.home);
    return allow;
  } catch {
    return allow; // fail-open: autopilot's failure mode is "off"
  }
}
