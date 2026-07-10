import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** SessionStart(resume|compact) hook target; stdout is restored as context. */
export async function recap(projectDir: string): Promise<string | null> {
  try {
    return await readFile(join(projectDir, "progress.md"), "utf8");
  } catch {
    return null;
  }
}
