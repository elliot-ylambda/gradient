export interface LLMRequest {
  system: string;
  prompt: string;
  signal?: AbortSignal;
}

export interface LLMBackend {
  name: string;
  available(): Promise<boolean>;
  complete(req: LLMRequest): Promise<string>;
}
