import type { LLMBackend } from "./backend.js";
import { ClaudeCliBackend } from "./claudeCli.js";
import { AnthropicBackend } from "./anthropic.js";
import type { Config } from "../core/types.js";

export async function selectBackend(
  deps: { candidates?: LLMBackend[]; config?: Config } = {},
): Promise<LLMBackend | null> {
  const candidates =
    deps.candidates ??
    [new ClaudeCliBackend({ model: deps.config?.model }), new AnthropicBackend({ model: deps.config?.model })];
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
