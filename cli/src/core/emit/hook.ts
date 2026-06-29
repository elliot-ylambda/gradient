import type { HookArtifact, SuggestionDraft } from "../../types";
import { KNOWN_SUBCOMMANDS } from "../validate";

// Hooks gradient emits always invoke a tested `gradient` subcommand — never
// bespoke inline shell (spec §2). v1's only evidence-backed hook is the
// PreCompact checkpoint, motivated by /compact being run 143×.
const HOOK_MAP: Record<string, { event: string; subcommand: string }> = {
  compact: { event: "PreCompact", subcommand: "checkpoint" },
  checkpoint: { event: "PreCompact", subcommand: "checkpoint" },
};

export function emitHook(s: SuggestionDraft): HookArtifact {
  const key = Object.keys(HOOK_MAP).find((k) => s.title.toLowerCase().includes(k));
  const mapping = key ? HOOK_MAP[key]! : { event: "PreCompact", subcommand: "checkpoint" };

  if (!KNOWN_SUBCOMMANDS.has(mapping.subcommand)) {
    throw new Error(`cannot emit hook for unknown subcommand: ${mapping.subcommand}`);
  }

  const settingsPatch = JSON.stringify(
    {
      hooks: {
        [mapping.event]: [
          { hooks: [{ type: "command", command: `gradient ${mapping.subcommand}` }] },
        ],
      },
    },
    null,
    2,
  );

  return {
    kind: "hook",
    event: mapping.event,
    subcommand: mapping.subcommand,
    settingsPatch,
  };
}
