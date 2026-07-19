import type { LLMBackend } from "./backend.js";
import { ClaudeCliBackend } from "./claudeCli.js";
import { AnthropicBackend } from "./anthropic.js";
import { CodexCliBackend } from "./codexCli.js";
import type { Config } from "../core/types.js";
import { resolveTargets } from "../config.js";

/** Default backend candidates. CLI children create a private per-call cwd and
 * disable tools/customizations before seeing untrusted transcript snippets. */
export function defaultCandidates(config?: Config): LLMBackend[] {
  const claude = new ClaudeCliBackend({
    model: config?.model,
    extraEnv: { GRADIENT_AUTOPILOT_CHILD: "1" },
  });
  const codex = new CodexCliBackend({ model: config?.codexModel });
  const anthropic = new AnthropicBackend({ model: config?.model });
  const targets = resolveTargets(config ?? {});
  if (config?.backend === "codex-cli" || (targets.includes("codex") && !targets.includes("claude-code"))) {
    return [codex, claude, anthropic];
  }
  if (targets.includes("codex")) return [claude, codex, anthropic];
  return [claude, anthropic];
}

export async function selectBackend(
  deps: { candidates?: LLMBackend[]; config?: Config } = {},
): Promise<LLMBackend | null> {
  const candidates = deps.candidates ?? defaultCandidates(deps.config);
  if (deps.config?.backend) {
    const chosen = candidates.find(candidate => candidate.name === deps.config!.backend);
    // Explicit provider pins are privacy boundaries: never fall back to a
    // different service when the requested backend is missing or unavailable.
    return chosen && (await chosen.available()) ? chosen : null;
  }
  for (const candidate of candidates) {
    if (await candidate.available()) return candidate;
  }
  return null;
}
