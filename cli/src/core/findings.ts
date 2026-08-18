import { createHash } from "node:crypto";
import type { Assistant, Suggestion } from "./types.js";
import type { AdoptionRow } from "./adoption.js";
import type { InstructionLine, InstructionSet } from "./instructions.js";
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
  | "delete-file"
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

/**
 * The bridge finding, and the reason it is ranked first.
 *
 * Claude Code reads CLAUDE.md and not AGENTS.md. Until a repository with both
 * has the documented `@AGENTS.md` import, every other cross-assistant proposal
 * has to be written twice; afterwards, one file serves both. Fixing it first
 * makes every later finding cheaper.
 */
function driftFindings(input: FindingsInput): Finding[] {
  const { bridge } = input.instructions;
  const out: Finding[] = [];
  const both = input.targets.includes("claude-code") && input.targets.includes("codex");

  if (both && bridge.agentsMdExists && !bridge.importsAgentsMd && !bridge.symlinked) {
    out.push({
      id: findingId("drift", "agents-md-bridge", [bridge.claudeMdPath]),
      family: "drift",
      severity: "high",
      title: "AGENTS.md is not reaching Claude Code",
      detail:
        "Claude Code reads CLAUDE.md and never AGENTS.md. Importing it with a single " +
        "`@AGENTS.md` line at the top of CLAUDE.md gives both assistants the same instructions " +
        "from one file, and stops every future rule from having to be written twice.",
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

function staleFindings(input: FindingsInput): Finding[] {
  return input.stale.map(ref => ({
    id: findingId("stale", ref.ref, [ref.line.source.path]),
    family: "stale" as const,
    severity: "high" as const,
    title: `${displayPath(ref.line.source.path, input.projectDir)}:${ref.line.line} refers to something that is gone`,
    detail:
      `The instruction names ${JSON.stringify(ref.ref)}, and ${ref.detail}. ` +
      "An instruction the repository has outgrown costs context in every session and " +
      "points the assistant at nothing.",
    evidence: oneLine(ref.line.text),
    targets: [ref.line.source.assistant],
    deterministic: true,
    // Rewriting prose is a judgment call, so the change is proposed as an
    // outright deletion and anything better comes from the skill.
    commandBearing: COMMAND_BEARING.test(ref.line.text),
    changes: [{
      op: "delete-line" as const,
      path: ref.line.source.path,
      assistant: ref.line.source.assistant,
      line: ref.line.line,
      before: ref.line.text,
    }],
  }));
}

function skillProblemFinding(
  skill: InstalledSkill,
  input: FindingsInput,
): Finding | null {
  if (skill.problems.length === 0) return null;
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
      `${list(nonStandard)} ${nonStandard.length > 1 ? "are" : "is"} outside the Agent Skills spec's ` +
      `six fields, so this skill cannot be uploaded to claude.ai, used through the Skills API, or ` +
      `packaged. Claude Code itself ignores ${nonStandard.length > 1 ? "them" : "it"}.`);
  }
  if (nonPortable.length > 0) {
    sentences.push(
      `${list(nonPortable)} ${nonPortable.length > 1 ? "are" : "is"} a Claude Code extension, so this ` +
      `skill does nothing under Codex.`);
  }
  for (const problem of skill.problems) {
    switch (problem.kind) {
      case "unreadable-frontmatter":
        sentences.push(`Its frontmatter cannot be read (${problem.detail}), so nothing loads it.`);
        break;
      case "no-description":
        sentences.push("It has no description, so selection falls back to the first paragraph of the body.");
        break;
      case "description-over-cap":
        sentences.push(`Its description is ${problem.chars} characters; everything past 1,536 is truncated out of the listing.`);
        break;
      case "duplicate-description":
        sentences.push(`Its description is barely distinguishable from \`${problem.other}\`, so the model picks between them arbitrarily.`);
        break;
    }
  }
  const detail = sentences.join(" ");

  return {
    id: findingId("skill-health", skill.name, [skill.path]),
    family: "skill-health",
    severity: blocking ? "high" : "medium",
    title: blocking
      ? `The ${skill.name} skill will not load (${skill.assistant})`
      : affectsSelection
        ? `The ${skill.name} skill is unlikely to be selected (${skill.assistant})`
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
    deterministic: true,
    commandBearing: false,
    // Repairing frontmatter is authoring; the finding reports and the skill fixes.
    changes: [],
  };
}

function unusedFindings(input: FindingsInput): Finding[] {
  const byName = new Map(input.surface.skills.map(skill => [skill.name, skill]));
  return input.adoption
    .filter(row => row.suggestRemoval)
    .map(row => {
      const skill = byName.get(row.name);
      return {
        id: findingId("skill-health", `unused:${row.name}`, [skill?.path ?? row.name]),
        family: "skill-health" as const,
        severity: "medium" as const,
        title: `${row.name} has never been invoked`,
        detail:
          "Its description is loaded into every session whether or not it is used. " +
          "Removing it is reversible; gradient generated it and can generate it again.",
        evidence: `installed ${row.createdAt} · 0 uses`,
        targets: [skill?.assistant ?? "claude-code"],
        deterministic: true,
        commandBearing: false,
        changes: skill
          ? [{ op: "delete-file" as const, path: skill.path, assistant: skill.assistant }]
          : [],
      };
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
      title: `An instruction in ${displayPath(best.line.source.path, input.projectDir)} is not holding`,
      detail:
        `Line ${best.line.line} already says this, and it was still typed ` +
        `${suggestion.evidence.count} times across ${suggestion.evidence.sessions} sessions. ` +
        "An instruction is a request; a hook or a skill is a guarantee. Promote it, or drop the line " +
        "and stop paying for it in every session.",
      evidence: oneLine(best.line.text),
      targets: [best.line.source.assistant],
      deterministic: true,
      commandBearing: COMMAND_BEARING.test(best.line.text),
      changes: [],
    });
  }
  return { findings: out, restated };
}

function workflowFindings(input: FindingsInput, restated: Set<string>): Finding[] {
  return input.suggestions
    .filter(suggestion => !restated.has(suggestion.id))
    .map(suggestion => ({
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
      targets: input.targets,
      deterministic: true,
      commandBearing: false,
      changes: [],
      suggestion,
    }));
}

function practiceFindings(input: FindingsInput): Finding[] {
  const out: Finding[] = [];

  for (const source of input.instructions.sources) {
    if (source.kind === "rule" || source.lineCount <= CLAUDE_MD_MAX_LINES) continue;
    out.push({
      id: findingId("practice", "length", [source.path]),
      family: "practice",
      severity: "low",
      title: `${displayPath(source.path, input.projectDir)} is ${source.lineCount} lines`,
      detail:
        `The documented target is under ${CLAUDE_MD_MAX_LINES} lines: longer files consume more context ` +
        "and measurably reduce adherence. Path-scoped rules under `.claude/rules/` load only when Claude " +
        "touches matching files, which is the documented way to shorten this without losing anything.",
      evidence: `${source.lineCount} lines · ${source.bytes} bytes, loaded every session`,
      targets: [source.assistant],
      deterministic: true,
      commandBearing: false,
      changes: [],
    });
  }

  // The same instruction in two loaded files is two chances to be followed
  // inconsistently, and the docs call out contradiction as a real failure mode.
  const byNormalized = new Map<string, InstructionLine[]>();
  for (const line of input.instructions.lines) {
    const group = byNormalized.get(line.normalized) ?? [];
    group.push(line);
    byNormalized.set(line.normalized, group);
  }
  for (const [, group] of byNormalized) {
    const distinct = group.filter((line, index) =>
      group.findIndex(other => other.source.path === line.source.path) === index);
    if (distinct.length < 2) continue;
    out.push({
      id: findingId("practice", "duplicate", distinct.map(line => `${line.source.path}:${line.line}`)),
      family: "practice",
      severity: "low",
      title: "The same instruction is written in more than one loaded file",
      detail:
        "Both files load every session, so the instruction is paid for twice and can drift into " +
        "two versions that disagree. Keep the one closest to where it applies.",
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
