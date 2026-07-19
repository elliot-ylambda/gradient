import type { Turn } from "./types.js";

const COMMAND_TAG_RE = /<command-name>\/?([\w:-]+)<\/command-name>/g;

/** Count command/skill invocation tags from raw, unfiltered user turns. */
export function countArtifactUses(
  turns: Turn[],
  since: Map<string, string>,
): Map<string, { uses: number; lastUsed?: string }> {
  const result = new Map<string, { uses: number; lastUsed?: string }>();
  const createdAt = new Map<string, number>();
  for (const [name, created] of since) {
    result.set(name, { uses: 0, lastUsed: undefined });
    createdAt.set(name, Date.parse(created));
  }

  for (const turn of turns) {
    if (turn.role !== "user" || !turn.text) continue;
    const usedAt = Date.parse(turn.ts);
    if (!Number.isFinite(usedAt)) continue;

    COMMAND_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COMMAND_TAG_RE.exec(turn.text)) !== null) {
      const record = result.get(match[1]);
      if (!record) continue;
      const created = createdAt.get(match[1]);
      if (created !== undefined && Number.isFinite(created) && usedAt < created) continue;
      record.uses += 1;
      if (!record.lastUsed || usedAt > Date.parse(record.lastUsed)) record.lastUsed = turn.ts;
    }
  }

  return result;
}
