/**
 * One interface, multiple backends (spec decision #6). The default reuses the
 * user's local `claude` CLI auth; an Anthropic-key backend is the fallback; the
 * seam is left open for a local model (ollama) in a later version.
 */
export type LLMBackend = {
  readonly name: string;
  /** Whether this backend can be used right now (binary present / key set). */
  available(): Promise<boolean>;
  /** Complete a single prompt and return the model's text. */
  complete(prompt: string): Promise<string>;
};
