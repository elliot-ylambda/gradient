import type { LLMBackend } from "./backend";
import { claudeCli } from "./claudeCli";
import { anthropic } from "./anthropic";

export type { LLMBackend } from "./backend";

/**
 * Pick the first available backend: local `claude` CLI, then Anthropic key.
 * Returns null when none is available — callers degrade to the no-LLM path.
 */
export async function selectBackend(): Promise<LLMBackend | null> {
  for (const backend of [claudeCli, anthropic]) {
    if (await backend.available()) return backend;
  }
  return null;
}
