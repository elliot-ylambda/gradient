import type { LLMBackend } from "./backend.js";
import { ClaudeCliBackend } from "./claudeCli.js";
import { AnthropicBackend } from "./anthropic.js";
import type { Config } from "../core/types.js";

/** Default backend candidates. Every gradient-spawned claude child carries the
 * autopilot recursion guard: if a project's Stop hook runs `gradient respond`
 * inside this child, respond's gate 1 sees the env var and stands down. */
export function defaultCandidates(config?: Config): LLMBackend[] {
  return [
    new ClaudeCliBackend({ model: config?.model, extraEnv: { GRADIENT_AUTOPILOT_CHILD: "1" } }),
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
    if (chosen && (await chosen.available())) return chosen;
  }
  for (const c of candidates) {
    if (await c.available()) return c;
  }
  return null;
}
