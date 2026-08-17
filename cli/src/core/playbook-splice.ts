/**
 * Line-surgical edits to a markdown file gradient shares with a human author.
 *
 * Appends never rewrite an existing line, removal deletes exactly the one line
 * it tagged, and everything outside the target section is left byte-identical.
 * Built for the committed `<repo>/gradient.md`; AGENTS.md reuses it whole,
 * because Codex has no `rules/` directory and a rule for Codex therefore has to
 * live inside a file the user also writes in. Tagged lines are what make that
 * safe: each rule is individually removable without touching its neighbours.
 */

export type PlaybookSection = "rules" | "workflows";

/** The heading gradient owns inside a file it does not own. */
export const SHARED_FILE_HEADING = "## gradient";

/** Skeleton for an AGENTS.md gradient has to create. Deliberately minimal: the
 *  file belongs to the user, and gradient is only claiming one section of it. */
export const AGENTS_MD_TEMPLATE = `# AGENTS.md

${SHARED_FILE_HEADING}
`;

const SECTION_HEADINGS: Record<PlaybookSection, string> = {
  rules: "## Rules",
  workflows: "## Workflows",
};

export const PROJECT_PLAYBOOK_TEMPLATE = `# gradient.md — repo automation contract

## Rules

## Workflows
`;

export function entryTag(suggestionId: string): string {
  return `<!-- gradient:${suggestionId} -->`;
}

export function spliceLine(
  existing: string | null,
  section: PlaybookSection,
  line: string,
  suggestionId: string,
): string {
  return spliceUnderHeading(existing, SECTION_HEADINGS[section], line, suggestionId, PROJECT_PLAYBOOK_TEMPLATE);
}

/**
 * Insert `line` at the end of `heading`'s section, creating the section (and
 * the file's skeleton) if absent. Idempotent on the tag, so re-applying a
 * finding is a no-op rather than a duplicate.
 */
export function spliceUnderHeading(
  existing: string | null,
  heading: string,
  line: string,
  suggestionId: string,
  template = "",
): string {
  const base = existing ?? template;
  if (base.includes(entryTag(suggestionId))) return base; // idempotent re-apply
  const lines = base.split("\n");
  const headingIndex = lines.findIndex(candidate => candidate.trim() === heading);
  if (headingIndex === -1) {
    const separator = base === "" || base.endsWith("\n") ? "" : "\n";
    return `${base}${separator}\n${heading}\n\n${line}\n`;
  }
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  }
  // Insert after the section's last non-blank line; an empty section gets one
  // blank line between heading and entry.
  let last = headingIndex;
  for (let i = headingIndex + 1; i < end; i++) {
    if (lines[i].trim() !== "") last = i;
  }
  if (last === headingIndex) lines.splice(headingIndex + 1, 0, "", line);
  else lines.splice(last + 1, 0, line);
  return lines.join("\n");
}

/**
 * Drop a heading gradient added once its last entry is gone.
 *
 * Without this, removing every gradient rule from a user's AGENTS.md leaves an
 * empty `## gradient` heading behind forever — litter in a file gradient was
 * only ever a guest in.
 */
export function dropEmptyHeading(content: string, heading: string): string {
  const lines = content.split("\n");
  const index = lines.findIndex(candidate => candidate.trim() === heading);
  if (index === -1) return content;
  let end = lines.length;
  for (let i = index + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
  }
  if (lines.slice(index + 1, end).some(candidate => candidate.trim() !== "")) return content;
  lines.splice(index, end - index);
  // Collapse the blank-line pair the removal can leave behind.
  while (lines.length > 1 && lines[lines.length - 1] === "" && lines[lines.length - 2] === "") lines.pop();
  return lines.join("\n");
}

export function removeTaggedLine(content: string, suggestionId: string): string | null {
  const tag = entryTag(suggestionId);
  const lines = content.split("\n");
  const index = lines.findIndex(candidate => candidate.includes(tag));
  if (index === -1) return null;
  lines.splice(index, 1);
  return lines.join("\n");
}

/** Set-difference diff: enough to show what consent would cover, without an
 * LCS implementation. Blank lines are noise and skipped. */
export function proseDiff(pinned: string, current: string): string {
  const pinnedLines = pinned.split("\n");
  const currentSet = new Set(current.split("\n"));
  const pinnedSet = new Set(pinnedLines);
  const removed = pinnedLines.filter(l => !currentSet.has(l) && l.trim() !== "");
  const added = current.split("\n").filter(l => !pinnedSet.has(l) && l.trim() !== "");
  return [...removed.map(l => `- ${l}`), ...added.map(l => `+ ${l}`)].join("\n");
}
