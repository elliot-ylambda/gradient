import type { ManifestEntry } from "../core/types.js";
import { loadManifest } from "../core/manifest.js";

export async function list(projectDir: string): Promise<ManifestEntry[]> {
  return loadManifest(projectDir);
}
