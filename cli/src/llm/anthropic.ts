import type { LLMBackend } from "./backend";

/**
 * Fallback backend: Anthropic SDK + ANTHROPIC_API_KEY. The SDK call is wired in
 * the implementation plan; v1 keeps the dependency optional so `npx gradient`
 * stays lean when the default `claude` CLI backend is present.
 */
export const anthropic: LLMBackend = {
  name: "anthropic-sdk",

  async available(): Promise<boolean> {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  },

  async complete(_prompt: string): Promise<string> {
    throw new Error(
      "anthropic backend not wired in this scaffold — set up @anthropic-ai/sdk in the implementation plan, or use the default claude CLI backend",
    );
  },
};
