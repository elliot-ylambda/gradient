import type { LLMBackend, LLMRequest } from "../llm/backend.js";

export const JUDGE_TIMEOUT_MS = 45_000; // hook entry timeout is 60s; leave headroom
export const MAX_RESPONSE_CHARS = 2000;
export const MAX_WHY_CHARS = 500;

export interface JudgeDecision {
  action: "continue" | "stand_down";
  response?: string;
  why: string;
}

export function buildJudgePrompt(
  mode: "nudge" | "full",
  playbook: string,
  projectPlaybook: string,
  tail: string,
): LLMRequest {
  const system =
    "You are the user's auto-responder for a Claude Code session that just stopped. " +
    "Decide whether the work is actually done or Claude stopped early. " +
    "If work is unfinished and Claude is not waiting on the user, reply with the nudge this user " +
    "would send, in their own phrasing (see YOUR PLAYBOOK). " +
    "If Claude asked the user a genuine question, or the work is done, stand down." +
    (mode === "full"
      ? " You may also answer routine questions and, when a task is complete, start this user's " +
        "typical next step per the playbooks. Stand down on anything irreversible or destructive " +
        "(pushes, deploys, deletions, spending) unless both playbooks' Rules explicitly allow it."
      : "") +
    ' Respond ONLY with JSON: {"action":"continue"|"stand_down","response":"<what to send>","why":"<one line>"}. ' +
    'action "continue" requires a non-empty response; omit response when standing down.';
  // Pinned-prose consent only: respond passes "" unless the local user's pin
  // matches the committed file's exact prose bytes.
  const projectBlock = projectPlaybook.trim()
    ? `PROJECT PLAYBOOK (this repo):\n${projectPlaybook}\n\n`
    : "";
  return {
    system,
    prompt:
      projectBlock +
      `YOUR PLAYBOOK:\n${playbook}\n\n` +
      `TRANSCRIPT TAIL:\n${tail}`,
  };
}

/** Models fence their JSON even when told "respond ONLY with JSON". Unwrap a
 * ```json … ``` block before parsing; everything inside stays strictly checked.
 * Without this the judge's reply never parses, respond fails open on every
 * stop, and autopilot silently never fires. */
function unfence(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return (m ? m[1] : t).trim();
}

/** Strict parse of the judge's reply. Anything off-contract throws (caller fails open). */
export function parseJudgeResponse(raw: string): JudgeDecision {
  const parsed = JSON.parse(unfence(raw)) as Record<string, unknown>;
  const action = parsed.action;
  if (action !== "continue" && action !== "stand_down") {
    throw new Error(`invalid judge action: ${String(action)}`);
  }
  const why = parsed.why;
  if (typeof why !== "string") throw new Error(`judge why must be a string, got ${typeof why}`);
  if (why.length > MAX_WHY_CHARS) throw new Error("judge why exceeds cap");
  if (action === "continue") {
    const response = parsed.response;
    if (typeof response !== "string" || !response.trim()) {
      throw new Error("judge continue requires a non-empty response");
    }
    if (response.length > MAX_RESPONSE_CHARS) throw new Error("judge response exceeds cap");
    return { action, response, why };
  }
  return { action, why };
}

/** One timed LLM call. Throws on timeout, backend error, or malformed output. */
export async function judge(
  backend: LLMBackend,
  req: LLMRequest,
  opts: { timeoutMs?: number } = {},
): Promise<JudgeDecision> {
  const ms = opts.timeoutMs ?? JUDGE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`judge timed out after ${ms}ms`));
      controller.abort();
    }, ms);
  });
  try {
    const raw = await Promise.race([backend.complete({ ...req, signal: controller.signal }), timeout]);
    return parseJudgeResponse(raw);
  } finally {
    clearTimeout(timer);
  }
}
