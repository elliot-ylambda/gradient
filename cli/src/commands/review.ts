import { createInterface } from "node:readline/promises";
import type { Assistant, Suggestion } from "../core/types.js";
import { applySuggestion, type ApplyResult } from "../core/apply.js";
import { isNudge, loadProjectPlaybook, loadPlaybookPin, savePlaybookPin, pinState, type PinState } from "../core/playbook.js";
import { loadSuggestions, saveSuggestions, syncApprovedPlaybook } from "./apply.js";
import { loadConfig, resolveCheapModel, resolveTargets } from "../config.js";
import { refreshRecallIndex } from "./recall.js";
import { emit, type EmitTarget } from "../core/emit/index.js";
import { clarifiedWorkflowBody } from "../core/detect.js";
import { stripUnsafeControls } from "../core/security.js";
import { proseDiff } from "../core/playbook-splice.js";
import { addDismissal, isDismissed, loadDismissed } from "../core/dismiss.js";

export type ReviewDecision = "approve" | "skip" | "explain" | "quit";

export type Prompter = (
  suggestion: Suggestion,
  index: number,
  total: number,
  preview: string,
) => Promise<ReviewDecision>;

/** Consent prompt for the committed gradient.md's prose. Approve pins the
 * exact bytes; the judge sees nothing until then. */
export type PlaybookPrompter = (diff: string, state: "unpinned" | "changed") => Promise<"approve" | "skip">;

/** Returns an option label, or null to leave the suggestion unresolved. */
export type Clarifier = (suggestion: Suggestion) => Promise<string | null>;

/** Replace an ambiguous command with the user's chosen reading. The cached
 * model-authored body is never trusted; the installable body is rebuilt from
 * the selected, bounded label and the local authorization guard. */
export function resolveClarify(suggestion: Suggestion, label: string): Suggestion | null {
  const clarify = suggestion.clarify;
  if (suggestion.confidence !== "flagged" || !clarify || clarify.chosen || suggestion.payload.type !== "command") {
    return null;
  }
  const option = clarify.options.find(candidate => candidate.label === label);
  if (!option) return null;
  const body = clarifiedWorkflowBody(option.label);
  return {
    ...suggestion,
    confidence: "high",
    payload: { ...suggestion.payload, body },
    clarify: {
      ...clarify,
      options: clarify.options.map(candidate => ({
        label: candidate.label,
        body: clarifiedWorkflowBody(candidate.label),
      })),
      chosen: option.label,
    },
  };
}

function renderedText(
  suggestion: Suggestion,
  target: Assistant,
  emitTarget: EmitTarget,
  cheapModel?: string,
): string {
  if (target === "codex" && suggestion.payload.type !== "command" && suggestion.payload.type !== "rule") {
    return `[${target}]\n(skipped: this artifact type is not supported)`;
  }
  const rendered = emit(suggestion, { target: emitTarget, assistant: target, cheapModel });
  const body = rendered.kind === "command" || rendered.kind === "skill" || rendered.kind === "rule"
    ? `${rendered.path}\n${rendered.content}`
    : rendered.kind === "loop"
      ? rendered.command
      : rendered.kind === "rule-print"
        ? rendered.text
        : rendered.kind === "playbook-line"
          ? `gradient.md (committed) → ## ${rendered.section === "rules" ? "Rules" : "Workflows"}\n${rendered.line}`
          : rendered.install
            ? `.claude/settings.local.json (merged on approve)\n` +
              `installs a ${rendered.install.event} hook (matcher: ${rendered.install.matcher ?? "all tools"})\n` +
              `that runs automatically: ${rendered.install.command}`
            : `.claude/settings.local.json (merged on approve)\n${rendered.settingsPatch ?? ""}`;
  return `[${target}]\n${body}`;
}

export function suggestionPreview(
  suggestion: Suggestion,
  emitTarget: EmitTarget,
  opts: { targets?: Assistant[]; cheapModel?: string } = {},
): string {
  return (opts.targets ?? ["claude-code"])
    .map(target => renderedText(suggestion, target, emitTarget, opts.cheapModel))
    .join("\n\n");
}

export async function review(
  projectDir: string,
  prompt: Prompter,
  opts: {
    home?: string;
    onSkip?: (message: string) => void;
    onExplain?: (message: string) => void;
    clarifier?: Clarifier;
    playbookPrompter?: PlaybookPrompter;
  } = {},
): Promise<ApplyResult[]> {
  const project = await loadProjectPlaybook(projectDir);
  if (project && opts.playbookPrompter) {
    const pin = await loadPlaybookPin(projectDir, opts.home);
    const state = pinState(project, pin);
    if (state === "unpinned" || state === "changed") {
      const diff = state === "unpinned"
        ? project.prose.split("\n").filter(l => l.trim() !== "").map(l => `+ ${l}`).join("\n")
        : proseDiff(pin!.prose, project.prose);
      if (await opts.playbookPrompter(stripUnsafeControls(diff), state) === "approve") {
        await savePlaybookPin(projectDir, project.prose, opts.home);
      }
    }
  }
  const cached = await loadSuggestions(projectDir, opts);
  const dismissed = await loadDismissed(projectDir);
  const suggestions = cached.filter(suggestion => !isDismissed(suggestion, dismissed));
  const config = await loadConfig(opts.home);
  const emitTarget = config.emitTarget ?? "skill";
  const targets = resolveTargets(config);
  const cheapModel = resolveCheapModel(config);
  const out: ApplyResult[] = [];
  for (let index = 0; index < suggestions.length; index++) {
    let suggestion = suggestions[index];
    if (suggestion.confidence === "flagged") {
      if (!opts.clarifier || !suggestion.clarify || suggestion.clarify.chosen || suggestion.payload.type !== "command") {
        opts.onSkip?.(`skipping unresolved flagged suggestion: ${suggestion.name}`);
        continue;
      }
      const label = await opts.clarifier(suggestion);
      const resolved = label === null ? null : resolveClarify(suggestion, label);
      // An unresolved ambiguity is never eligible for approval in this pass.
      if (!resolved) continue;
      suggestions[index] = suggestion = resolved;
      const cachedIndex = cached.findIndex(candidate => candidate.id === suggestion.id);
      if (cachedIndex >= 0) cached[cachedIndex] = resolved;
      // Persist the human decision to the private per-project cache before
      // artifact I/O so its provenance survives a target write failure.
      await saveSuggestions(projectDir, cached, opts.home);
    }

    let decision: ReviewDecision;
    do {
      decision = await prompt(
        suggestion,
        index,
        suggestions.length,
        suggestionPreview(suggestion, emitTarget, { targets, cheapModel }),
      );
      if (decision === "explain") opts.onExplain?.(suggestionExplanation(suggestion));
    } while (decision === "explain");
    if (decision === "quit") break;
    if (decision === "approve") {
      out.push(await applySuggestion(suggestion, projectDir, {
        emitTarget,
        targets,
        cheapModel,
        home: opts.home,
      }));
    } else if (decision === "skip") {
      await addDismissal(projectDir, suggestion);
    }
  }
  if (out.length > 0) {
    await syncApprovedPlaybook(projectDir, cached, opts.home);
    await refreshRecallIndex(projectDir, opts.home);
  }
  return out;
}

function terminalSafeLine(text: string): string {
  return stripUnsafeControls(text).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

export function suggestionExplanation(suggestion: Suggestion): string {
  const leverage = suggestion.evidence.estMinutesSavedPerMonth;
  const lines = [
    `  why: ${terminalSafeLine(suggestion.rationale)}`,
    `  evidence: seen ${suggestion.evidence.count}× across ${suggestion.evidence.sessions} sessions` +
      (leverage !== undefined ? ` · ≈${leverage}m/month` : ""),
  ];
  for (const example of suggestion.examples ?? []) lines.push(`    · ${terminalSafeLine(example)}`);
  return lines.join("\n");
}

export function readlineClarifier(): Clarifier {
  return async suggestion => {
    const clarify = suggestion.clarify!;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(`\n  ${terminalSafeLine(clarify.question)}\n`);
    clarify.options.forEach((option, index) => {
      process.stdout.write(`    [${index + 1}] ${terminalSafeLine(option.label)}\n`);
    });
    const answer = (await rl.question("  choose a number (enter to decide later) › ")).trim();
    rl.close();
    const index = Number(answer) - 1;
    return clarify.options[index]?.label ?? null;
  };
}

export function readlinePlaybookPrompter(): PlaybookPrompter {
  return async (diff, state) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(state === "unpinned"
      ? "\nThis repo's gradient.md is not yet approved as judge context for you:\n"
      : "\nThis repo's gradient.md changed since you approved it:\n");
    process.stdout.write(`${diff}\n`);
    const answer = (await rl.question("  approve it for your autopilot judge? [a]pprove [s]kip › ")).trim().toLowerCase();
    rl.close();
    return answer === "a" ? "approve" : "skip";
  };
}

export function readlinePrompter(
  _opts: { targets?: Assistant[]; cheapModel?: string } = {},
): Prompter {
  return async (suggestion, index, total, preview) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const label = suggestion.payload.type;
    const leverage = suggestion.evidence.estMinutesSavedPerMonth;
    process.stdout.write(
      `\n(${index + 1}/${total})  ${terminalSafeLine(suggestion.name)} · ${label} · ` +
      `seen ${suggestion.evidence.count}×` +
      (leverage !== undefined ? ` · ≈${leverage}m/month` : "") +
      ` · ${suggestion.confidence}\n` +
      `  ${terminalSafeLine(suggestion.title)}\n`,
    );
    const firstExample = suggestion.examples?.[0];
    if (firstExample) process.stdout.write(`  example: ${terminalSafeLine(firstExample)}\n`);
    if (suggestion.payload.type === "hook" && suggestion.payload.command) {
      process.stdout.write(
        `  installs a ${terminalSafeLine(suggestion.payload.event)} hook ` +
        `(matcher: ${terminalSafeLine(suggestion.payload.matcher ?? "all tools")})\n` +
        `  that runs automatically: ${terminalSafeLine(suggestion.payload.command)}\n`,
      );
    }
    process.stdout.write(`\n${stripUnsafeControls(preview)}\n`);
    if (isNudge(suggestion)) {
      process.stdout.write("  tip: this is what autopilot automates → gradient autopilot nudge\n");
    }
    const answer = (await rl.question("  [a]pprove [s]kip [e]xplain [q]uit › ")).trim().toLowerCase();
    rl.close();
    if (answer === "a") return "approve";
    if (answer === "e") return "explain";
    if (answer === "q") return "quit";
    return "skip";
  };
}

/** Non-interactive listing for tooling (the plugin's review skill). */
export async function reviewJson(projectDir: string, home?: string): Promise<string> {
  let projectPlaybook: PinState = "none";
  try {
    projectPlaybook = pinState(await loadProjectPlaybook(projectDir), await loadPlaybookPin(projectDir, home));
  } catch { /* fail closed: reported as none */ }
  try {
    const [suggestions, dismissed] = await Promise.all([
      loadSuggestions(projectDir, { home }),
      loadDismissed(projectDir),
    ]);
    return JSON.stringify({
      projectPlaybook,
      suggestions: suggestions.filter(suggestion => !isDismissed(suggestion, dismissed)),
    }, null, 2);
  } catch {
    return JSON.stringify({ projectPlaybook, suggestions: [] }, null, 2);
  }
}
