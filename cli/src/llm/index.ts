import type { LLMBackend } from "./backend.js";
import { ClaudeCliBackend } from "./claudeCli.js";
import { AnthropicBackend } from "./anthropic.js";
import type { Config } from "../core/types.js";

/** Default backend candidates. Every gradient-spawned claude child carries the
 * autopilot recursion guard: if a project's Stop hook runs `gradient respond`
 * inside this child, respond's gate 1 sees the env var and stands down.
 *
 * The child also runs in a private temporary cwd with persistence disabled.
 * Otherwise Claude Code records a
 * transcript for the headless session in the *project's* transcript dir, and the
 * next `gradient scan` mines gradient's own candidates JSON back as a user
 * prompt — the analysis engine feeding on its own output. */
export function defaultCandidates(config?: Config): LLMBackend[] {
  return [
    new ClaudeCliBackend({
      model: config?.model,
      extraEnv: { GRADIENT_AUTOPILOT_CHILD: "1" },
    }),
    new AnthropicBackend({ model: config?.model }),
  ];
}

export async function selectBackend(
  deps: { candidates?: LLMBackend[]; config?: Config } = {},
): Promise<LLMBackend | null> {
  const candidates = deps.candidates ?? defaultCandidates(deps.config);
  // honor explicit config.backend if set
  if (deps.config?.backend) {
    const chosen = candidates.find(c => c.name === deps.config!.backend);
    return chosen && (await chosen.available()) ? chosen : null;
  }
  for (const c of candidates) {
    if (await c.available()) return c;
  }
  return null;
}
