import type { Suggestion } from "../types";

// v1 ships exactly the hook-helper subcommands that back the hooks it can emit.
// emit/hook.ts may only reference a subcommand in this set; a hook naming an
// unknown subcommand is rejected here, so gradient never writes a broken hook.
export const KNOWN_SUBCOMMANDS = new Set<string>(["checkpoint"]);

export function validateSuggestion(s: Suggestion): Suggestion {
  if (!s.name) throw new Error("invalid suggestion: missing name");
  if (!s.type) throw new Error("invalid suggestion: missing type");
  if (s.artifact.kind !== s.type) {
    throw new Error(
      `invalid suggestion "${s.name}": artifact kind ${s.artifact.kind} != type ${s.type}`,
    );
  }
  if (
    s.artifact.kind === "hook" &&
    !KNOWN_SUBCOMMANDS.has(s.artifact.subcommand)
  ) {
    throw new Error(
      `hook "${s.name}" references unknown subcommand: ${s.artifact.subcommand}`,
    );
  }
  return s;
}
