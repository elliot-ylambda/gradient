import type { Suggestion } from "../core/types.js";
import { loadSuggestions } from "./apply.js";

export async function explain(
  projectDir: string,
  idOrName: string,
  opts: { home?: string; onSkip?: (message: string) => void } = {},
): Promise<Suggestion | undefined> {
  const all = await loadSuggestions(projectDir, opts);
  return all.find(s => s.id === idOrName || s.name === idOrName);
}
