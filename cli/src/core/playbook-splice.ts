/** Line-surgical edits for the committed <repo>/gradient.md. Appends never
 * rewrite existing lines; removal deletes exactly one tagged line. */

export type PlaybookSection = "rules" | "workflows";

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
  const base = existing ?? PROJECT_PLAYBOOK_TEMPLATE;
  if (base.includes(entryTag(suggestionId))) return base; // idempotent re-apply
  const heading = SECTION_HEADINGS[section];
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
