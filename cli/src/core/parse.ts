import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Turn } from "../types";

export type ParseResult = { turns: Turn[]; skipped: number };

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        // tool_result / tool_use blocks are intentionally ignored — only typed text.
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

function toolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.name === "string") names.push(b.name);
    }
  }
  return names;
}

/** JSONL transcript → Turn[]. Malformed lines are skipped and counted (never throws). */
export function parse(file: string): ParseResult {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { turns: [], skipped: 0 };
  }

  const turns: Turn[] = [];
  let skipped = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }

    const message = o.message as Record<string, unknown> | undefined;
    if (!message) continue;

    const project = basename(typeof o.cwd === "string" ? o.cwd : "");
    const branch =
      typeof o.gitBranch === "string" && o.gitBranch ? o.gitBranch : undefined;
    const ts = typeof o.timestamp === "string" ? o.timestamp : "";

    if (o.type === "user") {
      // subagent/sidechain turns and meta-injected turns are not genuine prompts.
      if (o.isSidechain === true || o.isMeta === true) continue;
      const text = extractText(message.content);
      if (text === undefined) continue;
      turns.push({ ts, project, branch, role: "user", source: file, text });
    } else if (o.type === "assistant") {
      const uses = toolNames(message.content);
      turns.push({
        ts,
        project,
        branch,
        role: "assistant",
        source: file,
        toolUses: uses.length ? uses : undefined,
      });
    }
  }

  return { turns, skipped };
}
