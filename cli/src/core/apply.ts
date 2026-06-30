import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Suggestion, ManifestEntry, ArtifactType } from "./types.js";
import { emit } from "./emit/index.js";
import { assertInside } from "./security.js";
import { addEntry } from "./manifest.js";

export interface ApplyResult {
  suggestion: Suggestion;
  written?: string;
  printed?: string;
}

export async function applySuggestion(s: Suggestion, projectDir: string): Promise<ApplyResult> {
  const result = emit(s);
  const type = s.payload.type as ArtifactType;
  let written: string | undefined;
  let printed: string | undefined;

  if (result.kind === "command") {
    const abs = join(projectDir, result.path);
    assertInside(join(projectDir, ".claude"), abs);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, result.content);
    written = abs;
  } else if (result.kind === "loop") {
    printed = result.command;
  } else {
    printed = result.settingsPatch; // hooks are surfaced for the user to approve into settings.json
  }

  const entry: ManifestEntry = {
    name: s.name,
    type,
    path: written ?? "",
    createdAt: new Date().toISOString().slice(0, 10),
    suggestionId: s.id,
  };
  await addEntry(projectDir, entry);
  return { suggestion: s, written, printed };
}
