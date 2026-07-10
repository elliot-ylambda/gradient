import { tmpdir } from "node:os";
import type { LLMBackend } from "./backend.js";
import { ClaudeCliBackend } from "./claudeCli.js";
import { AnthropicBackend } from "./anthropic.js";
import { CodexCliBackend } from "./codexCli.js";
import type { Config } from "../core/types.js";
import { resolveTargets } from "../config.js";

/** Default backend candidates. Every gradient-spawned claude child carries the
 * autopilot recursion guard: if a project's Stop hook runs `gradient respond`
 * inside this child, respond's gate 1 sees the env var and stands down.
 *
 * The child also runs in a neutral cwd. Otherwise Claude Code records a
 * transcript for the headless session in the *project's* transcript dir, and the
 * next `gradient scan` mines gradient's own candidates JSON back as a user
 * prompt — the analysis engine feeding on its own output. */
export function defaultCandidates(config?: Config): LLMBackend[] {
  const claude = new ClaudeCliBackend({
      model: config?.model,
      spawnCwd: tmpdir(),
      extraEnv: { GRADIENT_AUTOPILOT_CHILD: "1" },
    });
  const codex = new CodexCliBackend({ model: config?.codexModel, spawnCwd: tmpdir() });
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
