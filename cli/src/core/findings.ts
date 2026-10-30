import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Assistant, Suggestion } from "./types.js";
import type { AdoptionRow } from "./adoption.js";
import type { InstructionLine, InstructionSet, InstructionSource } from "./instructions.js";
import { displayPath } from "./instructions.js";
import type { StaleRef } from "./staleness.js";
import type { InstalledSkill, Surface } from "./surface.js";
import { MEMORY_INDEX_MAX_LINES } from "./surface.js";
import { containment, normalize, similarity } from "./cluster.js";
import { redact } from "./security.js";
import { isMeasured } from "./classify.js";

/**
 * One reviewable proposal, whatever produced it.
 *
 * Everything downstream — the terminal summary, `--json`, the page, `--apply`,
 * and dismissal — speaks in `Finding`. Mined workflow suggestions do not get a
 * parallel pipeline: one carries its `Suggestion` and applies through the
 * existing, well-tested `applySuggestion`, while every other family applies
 * through its `changes`. Two executors, but one list, one renderer, and one
 * dismissal key.
 */

export type Family =
  | "drift"
  | "stale"
  | "skill-health"
  | "dead-letter"
  | "workflow"
  | "practice"
  | "memory";

export type Severity = "high" | "medium" | "low";

export type ChangeOp =
  | "create"
  | "splice-line"
  | "replace-line"
  | "delete-line"
  | "prepend-import";

export interface Change {
  op: ChangeOp;
  path: string;
  assistant: Assistant;
  /** The exact existing text a line edit replaces, so apply can refuse a file
   *  that moved under it. */
  before?: string;
  after?: string;
  /** 1-based line the edit targets. */
  line?: number;
}

export interface Finding {
  id: string;
  family: Family;
  severity: Severity;
  title: string;
  detail: string;
  /** Where the claim comes from, in one line the user can check. */
  evidence: string;
  targets: Assistant[];
  /** False for anything needing judgment; `--auto` applies only true. */
  deterministic: boolean;
  /** True when the proposed text carries a command; barred from `--auto`. */
  commandBearing: boolean;
  changes: Change[];
  /** Set for family "workflow": applied through applySuggestion. */
  suggestion?: Suggestion;
}

/** One decision shared by the CLI, JSON, page, and executor. Native-feature
 * observations and unsupported assistant targets require a choice in context. */
export function findingActionability(finding: Finding): { actionable: boolean; reason?: string } {
  const proposal = finding.suggestion;
  if (!proposal) return finding.changes.length > 0
    ? { actionable: true }
    : { actionable: false, reason: "This observation needs review; Gradient has no file change to apply." };
  if (proposal.payload.type === "loop") {
    return { actionable: false, reason: "Review the assistant's native continuation or task controls first; no automation is installed." };
  }
  if (proposal.payload.type === "hook" && ["checkpoint", "recap"].includes(proposal.payload.subcommand ?? "")) {
    return { actionable: false, reason: "Review native compaction and memory first. Gradient continuity is an optional compatibility feature, enabled separately." };
  }
  if (!finding.targets.includes("claude-code") && proposal.payload.type !== "command" && proposal.payload.type !== "rule") {
    return { actionable: false, reason: "Gradient does not install this artifact for the selected assistant." };
  }
  return { actionable: true };
}

/** The exact proposed content is reviewable before a workflow is approved. */
export function findingPreview(finding: Finding): string | undefined {
  const payload = finding.suggestion?.payload;
  if (!payload) return undefined;
  switch (payload.type) {
    case "command": return payload.body;
    case "rule": return payload.text;
    case "project-playbook": return payload.text;
    case "hook": return `${payload.event}${payload.matcher ? ` (${payload.matcher})` : ""}: ${payload.command ?? `gradient ${payload.subcommand}`}`;
    case "loop": return payload.instruction;
  }
}

/** Ranked so the cheapest structural wins come before the interpretive ones. */
const FAMILY_ORDER: Family[] = [
  "drift", "stale", "skill-health", "dead-letter", "workflow", "practice", "memory",
];

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Documented target for a single instruction file before adherence drops. */
export const CLAUDE_MD_MAX_LINES = 200;

/** How much of a mined pattern must already appear in a written instruction for
 *  the instruction to count as restated rather than merely related. Containment
 *  rather than similarity: the typed phrase is expected to sit inside the longer
 *  written rule, which is exactly the case Jaccard scores badly. */
const RESTATEMENT_CONTAINMENT = 0.7;

/** Below this, a phrase is too short for containment to mean anything — almost
 *  any couple of words are "contained" in some instruction somewhere. The mined
 *  phrase has already cleared the recurrence gates by the time it gets here, so
 *  this only has to exclude the genuinely generic. */
const RESTATEMENT_MIN_CHARS = 12;
const RESTATEMENT_MIN_WORDS = 3;

const COMMAND_BEARING = /`[^`]+`|\b(?:run|execute|deploy|publish|push|install|delete|remove)\b/i;

function findingId(family: Family, subject: string, paths: string[]): string {
  return createHash("sha256")
    .update([family, subject, ...[...paths].sort()].join("\u0000"))
    .digest("hex")
    .slice(0, 12);
}

function oneLine(text: string, cap = 200): string {
  return redact(text).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, cap);
}

export interface FindingsInput {
  projectDir: string;
  targets: Assistant[];
  instructions: InstructionSet;
  surface: Surface;
  stale: StaleRef[];
  suggestions: Suggestion[];
  adoption: AdoptionRow[];
}

/** Offer an explicit bridge only when the inspected loading mode actually
 * excludes the same AGENTS.md that Codex uses. Native fallback needs no fix. */
function driftFindings(input: FindingsInput): Finding[] {
  const { bridge } = input.instructions;
  const out: Finding[] = [];
  const both = input.targets.includes("claude-code") && input.targets.includes("codex");

  if (both && bridge.agentsMdExists && !bridge.importsAgentsMd && !bridge.symlinked &&
      bridge.codexLoadsAgentsMd !== false &&
      !bridge.claudeLoadsAgentsMd && bridge.mode !== "managed-only" && bridge.mode !== "unknown" &&
      (bridge.claudeMdExists || bridge.mode === "claude-md" || (bridge.blockedBy?.length ?? 0) > 0)) {
    out.push({
      id: findingId("drift", "agents-md-bridge", [bridge.claudeMdPath]),
      family: "drift",
      severity: "high",
      title: "AGENTS.md is not reaching Claude Code",
      detail:
        "The inspected instruction mode prefers CLAUDE.md here, so AGENTS.md is not included. " +
        "An explicit `@AGENTS.md` import shares these repository instructions. " +
        "Review the two files for conflicting rules before adding it.",
      evidence: `${displayPath(bridge.agentsMdPath, input.projectDir)} exists; ` +
        `${displayPath(bridge.claudeMdPath, input.projectDir)} ${bridge.claudeMdExists ? "does not import it" : "does not exist"}`,
      targets: ["claude-code", "codex"],
      deterministic: true,
      commandBearing: false,
      changes: [{
        op: "prepend-import",
        path: bridge.claudeMdPath,
        assistant: "claude-code",
        after: "@AGENTS.md",
      }],
    });
  }
  return out;
}

/** Group by the real file, so a CLAUDE.md symlinked to AGENTS.md is reported
 *  — and edited — once; prefer the name that is not the link. */
function byRealFile<T>(items: readonly T[], sourceOf: (item: T) => InstructionSource, key = (_item: T) => ""): Array<{ source: InstructionSource; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const source = sourceOf(item);
    const id = `${source.realPath ?? source.path}\0${key(item)}`;
    const group = groups.get(id);
    if (group) group.push(item);
    else groups.set(id, [item]);
  }
  return [...groups.values()].map(group => {
    const sources = group.map(sourceOf);
    // By name: an ancestor directory may be a link too (macOS /var), so the
    // real file is the one whose own name matches what it resolves to.
    const real = sources.find(source => source.realPath !== undefined && basename(source.realPath) === basename(source.path));
    return { source: real ?? sources[0], items: group };
  });
}

/** One finding per line: every gone reference on it, and the one deletion
 *  that would answer them all. */
function staleFindings(input: FindingsInput): Finding[] {
  return byRealFile(input.stale, ref => ref.line.source, ref => String(ref.line.line)).map(({ source, items }) => {
    const line = items.find(ref => ref.line.source === source)!.line;
    const named = [...new Map(items.map(ref => [ref.ref, ref])).values()];
    const readOnly = items.some(ref => ref.line.source.readOnly);
    return {
      id: findingId("stale", named.map(ref => ref.ref).join(" "), [source.path]),
      family: "stale" as const,
      severity: "high" as const,
      title: `${displayPath(source.path, input.projectDir)}:${line.line} refers to something that is gone`,
      detail:
        (named.length === 1
          ? `The instruction names ${JSON.stringify(named[0].ref)}, and ${named[0].detail}. `
          : `The instruction names ${named.map(ref => `${JSON.stringify(ref.ref)} (${ref.detail})`).join(", ")}. `) +
        (readOnly
          ? "This is assistant-managed memory. Review it with the assistant that owns it; Gradient will not edit or delete it."
          : "The reference may be outdated or intentionally describe a missing file. Review the full instruction before choosing to remove this line."),
      evidence: oneLine(line.text),
      targets: [...new Set(items.map(ref => ref.line.source.assistant))],
      deterministic: true,
      // Rewriting prose is a judgment call, so the change is proposed as an
      // outright deletion and anything better comes from the skill.
      commandBearing: COMMAND_BEARING.test(line.text),
      changes: readOnly ? [] : [{
        op: "delete-line" as const,
        path: source.path,
        assistant: source.assistant,
        line: line.line,
        before: line.text,
      }],
    };
  });
}

function skillProblemFinding(
  skill: InstalledSkill,
  input: FindingsInput,
): Finding | null {
  if (skill.problems.length === 0) return null;
  // Ignored extension keys are not a setup problem. Keep them in inventory
  // for a packaging audit, without filling a working checkup with lint noise.
  if (skill.problems.every(problem => problem.kind === "non-standard-key" || problem.kind === "non-portable-key")) return null;
  // Only unreadable frontmatter actually stops a skill from loading. Claude
  // Code tolerates extra keys, so calling a non-standard key "broken" would be
  // a confident false alarm — the dogfood run flagged a working skill that way.
  const blocking = skill.problems.some(problem => problem.kind === "unreadable-frontmatter");
  // ...and saying an extra key makes a skill "unlikely to be selected" is the
  // same false alarm moved into the headline, which is the only line most
  // readers see. Selection is decided by the description; portability is a
  // separate defect with separate consequences, so it gets its own sentence.
  const affectsSelection = skill.problems.some(problem =>
    problem.kind === "no-description" ||
    problem.kind === "description-over-cap" ||
    problem.kind === "duplicate-description");

  // Grouped before rendering: one sentence per *kind*, not per key. Two extra
  // keys used to repeat the same 30-word explanation twice.
  const keysOfKind = (kind: "non-standard-key" | "non-portable-key"): string[] =>
    skill.problems.flatMap(problem => (problem.kind === kind ? [problem.key] : []));
  const list = (keys: string[]): string => keys.map(key => `\`${key}\``).join(" and ");
  const nonStandard = keysOfKind("non-standard-key");
  const nonPortable = keysOfKind("non-portable-key");

  const sentences: string[] = [];
  if (nonStandard.length > 0) {
    sentences.push(
      `${list(nonStandard)} ${nonStandard.length > 1 ? "are" : "is"} outside Gradient's known frontmatter fields. ` +
      `Claude Code ignores unknown keys; this does not establish a loading or selection failure. ` +
      `Check the destination's current documentation before changing portable metadata.`);
  }
  if (nonPortable.length > 0) {
    sentences.push(
      `${list(nonPortable)} ${nonPortable.length > 1 ? "are" : "is"} a Claude Code extension, so this ` +
      `metadata may behave differently under Codex; the skill body may still load.`);
  }
  for (const problem of skill.problems) {
    switch (problem.kind) {
      case "unreadable-frontmatter":
        sentences.push(`Gradient could not parse its frontmatter (${problem.detail}). Claude Code can still load the body without those fields; review metadata rather than assuming the skill is broken.`);
        break;
      case "no-description":
        sentences.push("It has no description, so selection falls back to the first paragraph of the body.");
        break;
      case "description-over-cap":
        sentences.push(`Its description is ${problem.chars} characters. A shorter, specific trigger may be easier to select; listing limits depend on the assistant and version.`);
        break;
      case "duplicate-description":
        sentences.push(`Its description overlaps with \`${problem.other}\`. Review whether their triggers are distinct; overlap alone does not prove incorrect selection.`);
        break;
    }
  }
  const detail = sentences.join(" ");

  return {
    id: findingId("skill-health", skill.name, [skill.path]),
    family: "skill-health",
    severity: "low",
    title: blocking
      ? `Review the ${skill.name} skill's frontmatter (${skill.assistant})`
      : affectsSelection
        ? `Review the ${skill.name} skill's description (${skill.assistant})`
        : `The ${skill.name} skill carries frontmatter outside the spec (${skill.assistant})`,
    detail,
    // Cite the number the finding is actually about. A portability problem
    // evidenced by "212 description chars" points at a healthy figure and
    // invites the reader to fix the wrong thing.
    evidence: `${displayPath(skill.path, input.projectDir)} · ${
      affectsSelection || blocking
        ? `${skill.descriptionChars} description chars`
        : `${[...nonStandard, ...nonPortable].join(", ")}`
    }`,
    targets: [skill.assistant],
    deterministic: false,
    commandBearing: false,
    // Repairing frontmatter is authoring; the finding reports and the skill fixes.
    changes: [],
  };
}

function unusedFindings(input: FindingsInput): Finding[] {
  // Only explicit Claude command/skill invocations are currently observable.
  // A missing event never proves a skill was not automatically selected.
  return input.adoption
    .filter(row => row.suggestRemoval && (row.type === "skill" || row.type === "command"))
    .flatMap(row => {
      const skill = input.surface.skills.find(item => item.name === row.name && item.assistant === "claude-code");
      if (!skill) return [];
      return [{
        id: findingId("skill-health", `unused:${row.name}`, [skill.path]),
        family: "skill-health" as const,
        severity: "low" as const,
        title: `No explicit invocation of ${row.name} was found`,
        detail: "No explicit invocation was recorded in the inspected history since installation. " +
          "Automatic selection and unavailable history may not be represented. Review whether this skill " +
          "still helps before choosing to remove it; Gradient never removes it automatically.",
        evidence: `installed ${row.createdAt} · ${row.uses} recorded explicit invocations`,
        targets: [skill.assistant],
        deterministic: false,
        commandBearing: false,
        changes: [],
      }];
    });
}

/**
 * Instructions the user keeps restating.
 *
 * A mined pattern that is nearly word-for-word a line already written down is
 * proof the written line is not holding: the user is paying its context cost
 * *and* typing it anyway. That is the one thing neither assistant can tell you
 * about your own instructions, and it needs no model to see.
 */
function deadLetterFindings(input: FindingsInput): { findings: Finding[]; restated: Set<string> } {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const restated = new Set<string>();

  for (const suggestion of input.suggestions) {
    const mined = [...(suggestion.sourceSignatures ?? []), ...(suggestion.examples ?? [])];
    if (mined.length === 0) continue;

    let best: { line: InstructionLine; score: number } | null = null;
    for (const line of input.instructions.lines) {
      for (const text of mined) {
        const typed = normalize(text);
        if (typed.length < RESTATEMENT_MIN_CHARS) continue;
        if (typed.split(" ").length < RESTATEMENT_MIN_WORDS) continue;
        const score = containment(typed, line.normalized);
        if (score >= RESTATEMENT_CONTAINMENT && (!best || score > best.score)) best = { line, score };
      }
    }
    if (!best) continue;
    // The suggestion is consumed either way: reporting the same habit twice,
    // once as "your rule is not holding" and once as "here is a new skill",
    // reads as two findings about one thing.
    restated.add(suggestion.id);
    const key = `${best.line.source.path}:${best.line.line}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: findingId("dead-letter", key, [best.line.source.path]),
      family: "dead-letter",
      severity: "medium",
      title: `A written instruction in ${displayPath(best.line.source.path, input.projectDir)} is also repeated in prompts`,
      detail:
        `Line ${best.line.line} already says this, and it was still typed ` +
        `${suggestion.evidence.count} times across ${suggestion.evidence.sessions} sessions. ` +
        "This may be a reminder or a repeated task, not evidence that the assistant ignored the rule. " +
        "Review whether the instruction is clear and whether the assistant already has a native control for it.",
      evidence: oneLine(best.line.text),
      targets: [best.line.source.assistant],
      deterministic: false,
      commandBearing: COMMAND_BEARING.test(best.line.text),
      changes: [],
    });
  }
  return { findings: out, restated };
}

/** Codex receives commands and rules; hooks, skills, and agents are Claude
 *  Code artifacts, so only Claude Code is a target for them (see apply). */
function appliesTo(suggestion: Suggestion, targets: readonly Assistant[]): Assistant[] {
  const portable = suggestion.payload.type === "command" || suggestion.payload.type === "rule";
  return targets.filter(target => target === "claude-code" || portable);
}

function workflowFindings(input: FindingsInput, restated: Set<string>): Finding[] {
  const hooked = new Set(input.surface.hookEvents ?? []);
  return input.suggestions
    .filter(suggestion => !restated.has(suggestion.id))
    // A Notification or PreCompact hook already installed — by the user or a
    // plugin — answers the same need; a second one only fires twice.
    .filter(suggestion => suggestion.payload.type !== "hook" || !hooked.has(suggestion.payload.event))
    .map(suggestion => ({ suggestion, targets: appliesTo(suggestion, input.targets) }))
    .filter(({ targets }) => targets.length > 0)
    .map(({ suggestion, targets }) => ({
      id: findingId("workflow", suggestion.id, []),
      family: "workflow" as const,
      severity: isMeasured(suggestion) ? ("medium" as const) : ("low" as const),
      title: suggestion.title,
      detail: suggestion.rationale,
      // isMeasured, not the raw field: a hook is event-derived by construction
      // and its builders do not set the flag, so reading the field directly
      // labelled the most-measured item in the list as inferred.
      evidence: `seen ${suggestion.evidence.count}× across ${suggestion.evidence.sessions} session(s)` +
        (isMeasured(suggestion) ? " · counted from tool events" : " · inferred from repeated prompts"),
      targets,
      deterministic: false,
      commandBearing: false,
      changes: [],
      suggestion,
    }));
}

function practiceFindings(input: FindingsInput): Finding[] {
  const out: Finding[] = [];

  const long = input.instructions.sources.filter(source => source.kind !== "rule" && source.lineCount > CLAUDE_MD_MAX_LINES);
  for (const { source, items } of byRealFile(long, source => source)) {
    const assistants = [...new Set(items.map(item => item.assistant))];
    out.push({
      id: findingId("practice", "length", [source.path]),
      family: "practice",
      severity: "low",
      title: `${displayPath(source.path, input.projectDir)} is ${source.lineCount} lines`,
      detail:
        assistants.includes("claude-code")
        ? "Claude recommends concise instruction files. Review repeated or outdated guidance; path-scoped rules can move specialized instructions closer to their use."
        : "Review whether these instructions are concise and still relevant. Codex instruction loading is subject to its configured byte budget; line count alone does not prove truncation.",
      evidence: `${source.lineCount} lines · ${source.bytes} bytes, loaded every session`,
      targets: assistants,
      deterministic: true,
      commandBearing: false,
      changes: [],
    });
  }

  // Codex reads project instructions up to `project_doc_max_bytes` and stops;
  // a long AGENTS.md is half-loaded with no sign of it in the session.
  const budget = input.instructions.codexBudget;
  if (budget && input.targets.includes("codex")) {
    const file = displayPath(budget.path, input.projectDir);
    const kib = (bytes: number): string => `${Math.round(bytes / 1024)} KiB`;
    out.push({
      id: findingId("practice", "codex-budget", [budget.path]),
      family: "practice",
      severity: "medium",
      title: budget.loaded > 0
        ? `Codex stops reading ${file} after ${kib(budget.loaded)} of ${kib(budget.bytes)}`
        : `Codex never reads ${file}: earlier instructions use its whole budget`,
      detail:
        `Codex loads instruction files up to project_doc_max_bytes (${budget.budget} bytes here) and leaves out the rest, ` +
        "so guidance past that point never reaches a Codex session. Raise project_doc_max_bytes in ~/.codex/config.toml, " +
        "or move detail into skills or nested AGENTS.md files.",
      evidence: `${budget.bytes} bytes · Codex budget ${budget.budget} bytes`,
      targets: ["codex"],
      deterministic: true,
      commandBearing: false,
      changes: [],
    });
  }

  // The same instruction in two loaded files is two chances to be followed
  // inconsistently, and the docs call out contradiction as a real failure mode.
  const byNormalized = new Map<string, InstructionLine[]>();
  for (const line of input.instructions.lines) {
    const key = `${line.source.assistant}\0${line.normalized}`;
    const group = byNormalized.get(key) ?? [];
    group.push(line);
    byNormalized.set(key, group);
  }
  for (const [, group] of byNormalized) {
    const distinct = group.filter((line, index) =>
      group.findIndex(other => other.source.path === line.source.path) === index);
    if (distinct.length < 2) continue;
    out.push({
      id: findingId("practice", "duplicate", distinct.map(line => `${line.source.path}:${line.line}`)),
      family: "practice",
      severity: "low",
      title: "The same instruction is written in multiple inspected files",
      detail:
        "This instruction appears in multiple inspected files for the same assistant. " +
        "Check their loading scope before consolidating them; path-scoped rules may not load together.",
      evidence: distinct
        .map(line => `${displayPath(line.source.path, input.projectDir)}:${line.line}`)
        .join(" · "),
      targets: [...new Set(distinct.map(line => line.source.assistant))],
      deterministic: true,
      commandBearing: false,
      changes: [],
    });
  }

  return out;
}

/** Read-only. Nothing here ever proposes a change inside the memory directory. */
function memoryFindings(input: FindingsInput): Finding[] {
  const memory = input.surface.memory;
  if (!memory) return [];
  const out: Finding[] = [];

  if (memory.overLineLimit || memory.overByteLimit) {
    const beyond = memory.lines.filter(line => line.beyondLimit).length;
    out.push({
      id: findingId("memory", "index-limit", [memory.indexPath]),
      family: "memory",
      severity: "medium",
      title: "The auto-memory index is past the size Claude Code loads",
      detail:
        `Only the first ${MEMORY_INDEX_MAX_LINES} lines or 25KB of MEMORY.md reach a session, ` +
        `so ${beyond} entr${beyond === 1 ? "y" : "ies"} never load. Claude Code maintains this file — ` +
        "asking it to shorten the index is the fix; gradient does not edit memory.",
      evidence: `${memory.totalLines} lines · ${memory.bytes} bytes`,
      targets: ["claude-code"],
      deterministic: true,
      commandBearing: false,
      changes: [],
    });
  }

  const claudeLines = input.instructions.lines.filter(line => line.source.assistant === "claude-code");
  for (const entry of memory.lines) {
    const duplicate = claudeLines.find(line => similarity(line.normalized, entry.normalized) >= 0.85);
    if (!duplicate) continue;
    out.push({
      id: findingId("memory", `duplicate:${entry.line}`, [memory.indexPath, duplicate.source.path]),
      family: "memory",
      severity: "low",
      title: "An auto-memory entry repeats a written instruction",
      detail:
        "It is already in an instruction file that loads every session, so the memory entry is " +
        "spending index budget on something Claude already has.",
      evidence: `MEMORY.md:${entry.line} ≈ ${displayPath(duplicate.source.path, input.projectDir)}:${duplicate.line}`,
      targets: ["claude-code"],
      deterministic: true,
      commandBearing: false,
      changes: [],
    });
  }

  return out;
}

export function buildFindings(input: FindingsInput): Finding[] {
  const deadLetter = deadLetterFindings(input);
  const all = [
    ...driftFindings(input),
    ...staleFindings(input),
    ...input.surface.skills.map(skill => skillProblemFinding(skill, input)).filter((f): f is Finding => f !== null),
    ...unusedFindings(input),
    ...deadLetter.findings,
    ...workflowFindings(input, deadLetter.restated),
    ...practiceFindings(input),
    ...memoryFindings(input),
  ];

  // Ids are stable across runs, so a duplicate is a genuine collision rather
  // than a re-run: keep the first and drop the rest.
  const seen = new Set<string>();
  const deduped: Finding[] = [];
  for (const finding of all) {
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    deduped.push(finding);
  }

  return deduped.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) ||
    a.title.localeCompare(b.title));
}
