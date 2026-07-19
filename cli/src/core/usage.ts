import type { CommandEvent } from "./types.js";
import { commandKey } from "./command.js";

/** Count command/skill invocation events since each artifact's creation. */
export function countArtifactUses(
  events: CommandEvent[],
  since: Map<string, string>,
): Map<string, { uses: number; lastUsed?: string }> {
  const result = new Map<string, { uses: number; lastUsed?: string }>();
  const createdAt = new Map<string, number>();
  for (const [name, created] of since) {
    result.set(name, { uses: 0, lastUsed: undefined });
    createdAt.set(name, Date.parse(created));
  }

  for (const event of events) {
    const usedAt = Date.parse(event.ts);
    if (!Number.isFinite(usedAt)) continue;

    const name = commandKey(event.command);
    if (!name) continue;
    const record = result.get(name);
    if (!record) continue;
    const created = createdAt.get(name);
    if (created !== undefined && Number.isFinite(created) && usedAt < created) continue;
    record.uses += 1;
    if (!record.lastUsed || usedAt > Date.parse(record.lastUsed)) record.lastUsed = event.ts;
  }

  return result;
}
