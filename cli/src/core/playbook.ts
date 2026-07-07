import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Suggestion } from "./types.js";

export const MINED_START = "<!-- gradient:mined:start -->";
export const MINED_END = "<!-- gradient:mined:end -->";

export const DEFAULT_PLAYBOOK = `# gradient.md — autopilot playbook

The Rules section is yours — edit freely. \`gradient scan\` refreshes only the
region between the mined markers.

${MINED_START}
_(run \`gradient scan\` to mine your habits into this section)_
${MINED_END}

## Rules

- Never green-light irreversible or destructive actions (pushes, deploys, deletions, spending).
- Stand down when a decision needs my judgment.
- Prefer standing down over guessing.
`;

export function playbookPath(home?: string): string {
  return join(home ?? homedir(), ".config", "gradient", "gradient.md");
}

/** A nudge is a cadence-less loop suggestion — "continue"-style, not scheduled. */
export function isNudge(s: Suggestion): boolean {
  return s.payload.type === "loop" && !s.payload.cadence;
}

export function renderMinedSection(suggestions: Suggestion[]): string {
  const nudgeLines = suggestions
    .filter(isNudge)
    .map(s => (s.payload.type === "loop"
      ? `- "${s.payload.instruction}" (seen ${s.evidence.count}× · ${s.evidence.sessions} sessions)`
      : ""))
    .filter(Boolean);
  const cmdLines = suggestions
    .filter(s => s.payload.type === "command")
    .map(s => `- /${s.name} — ${s.title}`);
  return [
    "## How I nudge (mined)",
    "",
    ...(nudgeLines.length ? nudgeLines : ["_no nudge patterns mined yet_"]),
    "",
    "## My workflows (mined)",
    "",
    ...(cmdLines.length ? cmdLines : ["_no workflow commands mined yet_"]),
  ].join("\n");
}

/** Splice the mined section into `existing` (or the default template). Returns
 * null when the markers are gone — the user owns the file, leave it alone. */
export function generatePlaybook(suggestions: Suggestion[], existing?: string): string | null {
  const base = existing ?? DEFAULT_PLAYBOOK;
  const start = base.indexOf(MINED_START);
  const end = base.indexOf(MINED_END);
  if (start === -1 || end === -1 || end < start) return null;
  return (
    base.slice(0, start + MINED_START.length) +
    "\n" + renderMinedSection(suggestions) + "\n" +
    base.slice(end)
  );
}

export async function writePlaybook(suggestions: Suggestion[], home?: string): Promise<string | null> {
  const path = playbookPath(home);
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null; // unreadable — leave it alone
    existing = undefined; // ENOENT → first run
  }
  const next = generatePlaybook(suggestions, existing);
  if (next === null) return null;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
  return path;
}

/** The judge's playbook. Built-in defaults when no file exists — autopilot works before the first scan. */
export async function loadPlaybook(home?: string): Promise<string> {
  try {
    return await readFile(playbookPath(home), "utf8");
  } catch {
    return DEFAULT_PLAYBOOK;
  }
}
