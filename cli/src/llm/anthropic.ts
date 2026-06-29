import Anthropic from "@anthropic-ai/sdk";
import type { LLMBackend, LLMRequest } from "./backend.js";

export class AnthropicBackend implements LLMBackend {
  name = "anthropic";
  private model: string;
  private apiKey: string | undefined;

  constructor(deps: { apiKey?: string; model?: string } = {}) {
    this.apiKey = deps.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = deps.model ?? "claude-sonnet-4-6";
  }

  async available(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async complete(req: LLMRequest): Promise<string> {
    const client = new Anthropic({ apiKey: this.apiKey });
    const resp = await client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    });
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("");
  }
}
