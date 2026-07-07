import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Suggestion, AutopilotMode } from "./types.js";

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

export interface ProjectClamps {
  maxMode?: AutopilotMode;  // ceiling in this repo; absent = no mode clamp
  budget?: number;          // ceiling in this repo; absent = no budget clamp
  malformed?: boolean;      // frontmatter present but unparseable → treat as off
}

export interface ProjectPlaybook {
  prose: string;            // file minus its frontmatter block; judge context
  clamps: ProjectClamps;
}

const MODE_RANK: Record<AutopilotMode, number> = { off: 0, nudge: 1, full: 2 };

/** The lower authority of two modes on off < nudge < full. */
export function clampMode(a: AutopilotMode, b: AutopilotMode): AutopilotMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

export function projectPlaybookPath(cwd: string): string {
  return join(cwd, "gradient.md");
}

const isMode = (v: string): v is AutopilotMode => v === "off" || v === "nudge" || v === "full";

/**
 * Lenient line scanner for the optional frontmatter clamp block. Recognizes
 * `max-mode:` and `budget:` lines anywhere inside the block (the `autopilot:`
 * grouping line is decorative); unknown keys ignored. No frontmatter → all
 * prose, empty clamps. Unclosed block, or a recognized key whose value is
 * anything but a clean valid token → { malformed: true } (caller clamps that
 * repo to off). Key-first, then validate: a recognized key with a bad or
 * decorated value must fail closed, never be silently ignored. Key matching
 * tolerates surrounding whitespace and is case-insensitive.
 */
export function parseProjectPlaybook(raw: string): ProjectPlaybook {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { prose: raw, clamps: {} }; // no frontmatter
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end === -1) return { prose: raw, clamps: { malformed: true } }; // unclosed

  const clamps: ProjectClamps = {};
  const malformed = (): ProjectPlaybook => ({ prose: bodyAfter(lines, end), clamps: { malformed: true } });
  for (let i = 1; i < end; i++) {
    const modeM = lines[i].match(/^\s*max-mode\s*:(.*)$/i);
    if (modeM) {
      const v = modeM[1].trim();
      if (!isMode(v)) return malformed();
      clamps.maxMode = v;
      continue;
    }
    const budgetM = lines[i].match(/^\s*budget\s*:(.*)$/i);
    if (budgetM) {
      const v = budgetM[1].trim();
      const n = Number(v);
      if (v === "" || !Number.isInteger(n) || n < 0) return malformed();
      clamps.budget = n;
    }
  }
  return { prose: bodyAfter(lines, end), clamps };
}

function bodyAfter(lines: string[], end: number): string {
  return lines.slice(end + 1).join("\n");
}

/** The committed per-project gradient.md, or null when the repo has none.
 * Missing file (ENOENT) → null (no clamp). Unreadable file → { prose: "", clamps: { malformed: true } }
 * (a present-but-unreadable gradient.md must not grant authority). */
export async function loadProjectPlaybook(cwd: string): Promise<ProjectPlaybook | null> {
  try {
    return parseProjectPlaybook(await readFile(projectPlaybookPath(cwd), "utf8"));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null; // no file → no clamp, no prose
    return { prose: "", clamps: { malformed: true } }; // unreadable → fail closed
  }
}
