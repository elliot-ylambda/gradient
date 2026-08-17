import type { Assistant, Suggestion } from "../types.js";
import { emitLoop } from "./loop.js";
import { emitHook } from "./hook.js";
import type { HookInstall } from "./hook.js";
import { emitSkill } from "./skill.js";
import { emitRule } from "./rule.js";
import { emitCodexSkill } from "./codex-skill.js";
import { emitCodexRule } from "./codex-rule.js";
import { emitProjectPlaybook } from "./project-playbook.js";

export interface EmitOpts {
  assistant?: Assistant;
  cheapModel?: string;
  /** Command prefix an installed hook uses to reach gradient. Resolved by the
   *  caller, because it depends on how this process itself was launched. */
  hookBinary?: string;
}
export type EmitResult =
  | { kind: "skill"; path: string; content: string; assistant: Assistant }
  | { kind: "loop"; command: string }
  | { kind: "hook"; settingsPatch?: string; install?: HookInstall }
  | { kind: "rule"; path: string; content: string }
  | { kind: "block-line"; line: string }
  | { kind: "playbook-line"; section: "rules" | "workflows"; line: string };

export { emitSkill };

export function emit(s: Suggestion, opts: EmitOpts = {}): EmitResult {
  const assistant = opts.assistant ?? "claude-code";
  if (assistant === "codex" && s.payload.type !== "command" && s.payload.type !== "rule") {
    throw new Error("codex target supports skills and AGENTS.md rules");
  }
  switch (s.payload.type) {
    case "command":
      // Custom commands were merged into skills upstream: a `.claude/commands/x.md`
      // and a `.claude/skills/x/SKILL.md` both produce `/x`, and only the skill
      // can be loaded automatically when it is relevant. So skills are the only
      // thing gradient emits.
      return assistant === "codex"
        ? { kind: "skill", assistant, ...emitCodexSkill(s) }
        : { kind: "skill", assistant, ...emitSkill(s, { model: opts.cheapModel }) };
    case "loop": return { kind: "loop", ...emitLoop(s) };
    case "hook": return { kind: "hook", ...emitHook(s, opts.hookBinary) };
    case "rule":
      return assistant === "codex"
        ? { kind: "block-line", ...emitCodexRule(s) }
        : { kind: "rule", ...emitRule(s) };
    case "project-playbook": return { kind: "playbook-line", ...emitProjectPlaybook(s) };
  }
}
