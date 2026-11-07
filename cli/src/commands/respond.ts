import type { Config } from "../core/types.js";
import { boundedAutopilotBudget, loadConfig, DEFAULT_AUTOPILOT_MODEL, projectKey, supportsClaudeHooks } from "../config.js";
import { loadState, saveState, cleanupStale } from "../core/state.js";
import { renderTail, fingerprint, lastAssistantTurn, readTranscriptLines } from "../core/tail.js";
import { loadPlaybook, loadProjectPlaybook, clampMode, loadPlaybookPin, pinnedProse } from "../core/playbook.js";
import { buildJudgePrompt, judge } from "../core/judge.js";
import { redact } from "../core/security.js";
import { selectBackend } from "../llm/index.js";
import { ClaudeCliBackend } from "../llm/claudeCli.js";
import { AnthropicBackend } from "../llm/anthropic.js";
import { CodexCliBackend } from "../llm/codexCli.js";
import type { LLMBackend } from "../llm/backend.js";

export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean; // intentionally unused as a gate (spec §1): budget + progress are the loop protection
}

const PLAYBOOK_CAP = 4096;
export const SAFE_NUDGE = "Continue.";

/** Failed requests worth retrying at once: a server-side failure or an
 *  overloaded API. Not a rate limit (an immediate "Continue." meets the same
 *  limit), not an authentication failure, and not a kind this list has never
 *  seen. In 30 days of real history every cut-off response was resumed — by
 *  the user or by a coordinator. */
const RETRYABLE_API_ERRORS: ReadonlySet<string> = new Set(["server_error", "overloaded_error", "overloaded"]);

/** Steps the user decides. When the last message names one, anywhere in it,
 *  autopilot stays out, whatever a judge would say: a "Continue." there is a
 *  go-ahead. Verb forms, so "pushed", "sending", and "posted" count, while
 *  "payload", "Postgres", and "dropdown" do not. */
const USER_DECIDES = new RegExp("\\b(?:" + [
  "push(?:es|ed|ing)?", "deploy\\w*", "releas\\w*", "publish\\w*", "merg(?:e|es|ed|ing)", "rebas\\w*",
  "delet\\w*", "remov\\w*", "rm -rf", "drop(?:s|ped|ping)?", "truncat\\w*", "migrat\\w*", "rotat\\w*", "revok\\w*",
  "send(?:s|ing)?", "sent", "e-?mail(?:s|ed|ing)?", "post(?:s|ed|ing)?", "tweet\\w*",
  "pay(?:s|ing|ments?)?", "paid", "charg(?:e|es|ed|ing)", "purchas\\w*", "spend(?:s|ing)?", "spent", "refund\\w*",
  "prod", "production", "ship(?:s|ped|ping)?", "tag(?:s|ged|ging)?",
].join("|") + ")\\b", "i");

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

export async function autopilotBackend(config: Config): Promise<LLMBackend | null> {
  const model = config.autopilotModel ?? DEFAULT_AUTOPILOT_MODEL;
  return selectBackend({
    config,
    candidates: [
      // Private cwd + guard env: the headless child must never re-enter this hook.
      new ClaudeCliBackend({ model, extraEnv: { GRADIENT_AUTOPILOT_CHILD: "1" } }),
      new AnthropicBackend({ model: ANTHROPIC_MODEL_ALIASES[model] ?? model }),
      // Transcript tails go to a different provider only when the user pinned it.
      ...(config.backend === "codex-cli" ? [new CodexCliBackend({ model: config.codexModel })] : []),
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
    if (!supportsClaudeHooks(config)) return allow;
    const mode = input.cwd ? config.autopilotProjects?.[projectKey(input.cwd)] : undefined;
    // "full" from legacy/tampered config fails closed. Only per-project nudge
    // consent is supported in the hardened release.
    if (mode !== "nudge") return allow;
    // cwd joins the required hook fields: without it the project clamp can't
    // be checked, and "can't check the clamp" must mean "no action" — never
    // "act unclamped".
    if (!input.session_id || !input.transcript_path || !input.cwd) return allow;

    // Gate 2b: project clamp (spec §4). A committed gradient.md may only
    // restrict authority. Malformed frontmatter clamps this repo to off.
    let effectiveBudget = boundedAutopilotBudget(config.autopilotBudget);
    const project = await loadProjectPlaybook(input.cwd);
    if (project) {
      if (project.clamps.malformed) return allow; // fail closed: off
      if (project.clamps.maxMode && clampMode(mode, project.clamps.maxMode) !== "nudge") return allow; // clamped to off
      if (project.clamps.budget !== undefined) {
        effectiveBudget = Math.min(effectiveBudget, project.clamps.budget);
      }
    }

    void cleanupStale(deps.home).catch(() => {}); // opportunistic, never awaited on the hot path

    // Gate 3: budget (effective).
    const state = await loadState(input.session_id, deps.home);
    if (state.attempts >= effectiveBudget) return allow;

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

    // Gate 5: the last message, checked locally before any model call.
    const ts = (deps.now ?? (() => new Date().toISOString()))();
    // The veto runs first: a turn cut off mid-"I'll deploy now" stays stopped.
    const last = lastAssistantTurn(lines);
    if (USER_DECIDES.test(last.text)) {
      state.log.push({ ts, action: "stand_down", why: "the last message names a step the user decides", excerpt: "" });
      await saveState(input.session_id, state, deps.home);
      return allow;
    }
    if (last.apiError !== undefined && RETRYABLE_API_ERRORS.has(last.apiError)) {
      state.attempts += 1;
      state.count += 1;
      state.lastFingerprint = fp;
      state.log.push({ ts, action: "continue", why: "the response was cut off", excerpt: SAFE_NUDGE });
      await saveState(input.session_id, state, deps.home);
      return { decision: "block", reason: SAFE_NUDGE };
    }

    const backend = deps.backend !== undefined ? deps.backend : await autopilotBackend(config);
    if (!backend) return allow;

    const tail = redact(renderTail(lines));
    const playbook = redact(await loadPlaybook(deps.home)).slice(0, PLAYBOOK_CAP);
    // Pin check fails closed: any error below yields "" and the judge sees
    // only the personal playbook. Clamps above already applied regardless.
    const pin = await loadPlaybookPin(input.cwd, deps.home);
    const projectProse = redact(pinnedProse(project, pin)).slice(0, PLAYBOOK_CAP);
    // Persist the attempt and fingerprint before the paid call. Errors and
    // stand-downs still consume budget and identical failed tails are not retried.
    state.attempts += 1;
    state.lastFingerprint = fp;
    await saveState(input.session_id, state, deps.home);
    const decision = await judge(
      backend,
      buildJudgePrompt(playbook, projectProse, tail),
      { timeoutMs: deps.timeoutMs },
    );

    if (decision.action === "continue" && decision.response) {
      state.count += 1;
      state.log.push({ ts, action: "continue", why: decision.why, excerpt: SAFE_NUDGE });
      await saveState(input.session_id, state, deps.home);
      return { decision: "block", reason: SAFE_NUDGE };
    }
    state.log.push({ ts, action: "stand_down", why: decision.why, excerpt: "" });
    await saveState(input.session_id, state, deps.home);
    return allow;
  } catch {
    return allow; // fail-open: autopilot's failure mode is "off"
  }
}
