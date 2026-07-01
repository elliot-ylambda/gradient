import type { Suggestion } from "../core/types.js";
import { loadSuggestions } from "./apply.js";

export async function explain(projectDir: string, idOrName: string): Promise<Suggestion | undefined> {
  const all = await loadSuggestions(projectDir);
  return all.find(s => s.id === idOrName || s.name === idOrName);
}
