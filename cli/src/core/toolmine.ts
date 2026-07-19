import type { Candidate, ToolEvent } from "./types.js";

export const TOOLMINE = {
  FAIL_MIN_COUNT: 3,
  FAIL_MIN_SESSIONS: 2,
  RITUAL_WINDOW: 3,
  RITUAL_MIN_OBS: 15,
  RITUAL_MIN_SESSIONS: 3,
  RITUAL_ATTACH_RATIO: 0.4,
  HEAD_MAX: 80,
} as const;

/** Normalize the stable command portion used to group failures and rituals. */
export function commandHead(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, TOOLMINE.HEAD_MAX);
}

interface Group {
  count: number;
  sessionIds: Set<string>;
  examples: string[];
}

function grow(groups: Map<string, Group>, key: string, sessionId: string, example?: string): void {
  const group = groups.get(key) ?? {
    count: 0,
    sessionIds: new Set<string>(),
    examples: [],
  };
  group.count++;
  group.sessionIds.add(sessionId);
  if (example && group.examples.length < 3 && !group.examples.includes(example)) {
    group.examples.push(example);
  }
  groups.set(key, group);
}

function toCandidate(kind: "toolfail" | "ritual", signature: string, group: Group): Candidate {
  return {
    kind,
    signature,
    examples: group.examples.length > 0 ? group.examples : [signature],
    count: group.count,
    sessions: group.sessionIds.size,
    sessionIds: [...group.sessionIds].sort(),
    confidence: "inferred",
  };
}

function rankedCandidates(
  groups: Map<string, Group>,
  kind: "toolfail" | "ritual",
  predicate: (group: Group) => boolean,
): Candidate[] {
  return [...groups.entries()]
    .filter(([, group]) => predicate(group))
    .map(([signature, group]) => toCandidate(kind, signature, group))
    .sort((left, right) => right.count - left.count || left.signature.localeCompare(right.signature));
}

/** Find repeatedly failing command heads across independent sessions. */
export function failureLoops(events: ToolEvent[]): Candidate[] {
  const groups = new Map<string, Group>();
  for (const event of events) {
    if (event.kind !== "bash" || !event.isError || !event.command) continue;
    const key = commandHead(event.command);
    if (!key) continue;
    grow(groups, key, event.sessionId, event.errorHead);
  }
  return rankedCandidates(groups, "toolfail", group =>
    group.count >= TOOLMINE.FAIL_MIN_COUNT &&
    group.sessionIds.size >= TOOLMINE.FAIL_MIN_SESSIONS);
}

/** Find Bash commands repeatedly attached to the first three events after edits. */
export function rituals(events: ToolEvent[]): Candidate[] {
  const bySession = new Map<string, ToolEvent[]>();
  for (const event of events) {
    const sessionEvents = bySession.get(event.sessionId) ?? [];
    sessionEvents.push(event);
    bySession.set(event.sessionId, sessionEvents);
  }

  const groups = new Map<string, Group>();
  let editWindows = 0;
  for (const [sessionId, sessionEvents] of bySession) {
    for (let index = 0; index < sessionEvents.length; index++) {
      if (sessionEvents[index].kind !== "edit") continue;
      editWindows++;
      const seenInWindow = new Set<string>();
      const windowEnd = Math.min(sessionEvents.length, index + TOOLMINE.RITUAL_WINDOW + 1);
      for (let cursor = index + 1; cursor < windowEnd; cursor++) {
        const event = sessionEvents[cursor];
        if (event.kind !== "bash" || !event.command) continue;
        const key = commandHead(event.command);
        if (!key || seenInWindow.has(key)) continue;
        seenInWindow.add(key);
        grow(groups, key, sessionId, key);
      }
    }
  }

  return rankedCandidates(groups, "ritual", group =>
    group.count >= TOOLMINE.RITUAL_MIN_OBS &&
    group.sessionIds.size >= TOOLMINE.RITUAL_MIN_SESSIONS &&
    editWindows > 0 &&
    group.count / editWindows >= TOOLMINE.RITUAL_ATTACH_RATIO);
}
