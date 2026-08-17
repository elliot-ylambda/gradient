import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import type { InstructionLine } from "./instructions.js";
import { safeReadFile } from "./safeFs.js";

/**
 * Instructions that were true when they were written and are not true now.
 *
 * This is the only check that reads the repository rather than the transcripts,
 * and it is what keeps a CLAUDE.md honest as the code moves out from under it.
 *
 * Precision is the whole game. A false positive here proposes deleting a
 * correct instruction, so every rule below prefers saying nothing to guessing:
 * references are read only from unambiguous forms, only project-local paths are
 * resolved, and a missing binary on this machine is never evidence that an
 * instruction is wrong.
 */

const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_REFS_PER_LINE = 6;

/** Build output and vendored trees: present or absent, a reference to one says
 *  nothing about whether the instruction still holds. */
const IGNORED_ROOTS: ReadonlySet<string> = new Set([
  "node_modules", "dist", "build", "out", "coverage", "target", "vendor",
  ".next", ".turbo", ".venv", "__pycache__",
]);

export type StaleKind = "path" | "script";

export interface StaleRef {
  line: InstructionLine;
  /** The exact text to quote back; also what a rewrite has to replace. */
  ref: string;
  kind: StaleKind;
  detail: string;
}

export interface RepoFacts {
  scripts: Set<string>;
  makeTargets: Set<string>;
}

/** Anything with a placeholder, glob, or scheme is illustrative rather than a
 *  concrete reference. */
function isIllustrative(ref: string): boolean {
  return /[*?<>${}]/.test(ref) || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref) || ref.includes("...");
}

function isPathShaped(ref: string): boolean {
  if (!ref.includes("/") || ref.startsWith("~") || ref.startsWith("/")) return false;
  if (isIllustrative(ref)) return false;
  return !/\s/.test(ref);
}

/** `npm run build`, `pnpm test`, `make lint` — the package-script forms whose
 *  existence is checkable from the repository's own manifests. */
function scriptRef(text: string): { manager: "npm" | "make"; target: string } | null {
  const npm = /^(?:npm|pnpm|yarn|bun)\s+run\s+([A-Za-z0-9:_-]+)$/.exec(text);
  if (npm) return { manager: "npm", target: npm[1] };
  const make = /^make\s+([A-Za-z0-9:_.-]+)$/.exec(text);
  if (make) return { manager: "make", target: make[1] };
  return null;
}

/** Backticked spans, plus bare path-shaped tokens. Prose is not scanned for
 *  loose words: only forms an author marked as a literal. */
export function extractRefs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const ref = value.trim().replace(/[.,;:)]+$/, "");
    // Applied to backticked spans too: an author who writes `src/**/*.ts` is
    // describing a shape, not naming a file that ought to exist.
    if (!ref || isIllustrative(ref) || seen.has(ref) || out.length >= MAX_REFS_PER_LINE) return;
    seen.add(ref);
    out.push(ref);
  };

  let rest = text;
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    push(match[1]);
    rest = rest.replace(match[0], " ");
  }
  for (const token of rest.split(/\s+/)) {
    if (isPathShaped(token)) push(token);
  }
  return out;
}

export async function readRepoFacts(projectDir: string): Promise<RepoFacts> {
  const scripts = new Set<string>();
  const makeTargets = new Set<string>();

  try {
    const raw = await safeReadFile(projectDir, join(projectDir, "package.json"), { maxBytes: MAX_MANIFEST_BYTES });
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    for (const key of Object.keys(parsed.scripts ?? {})) scripts.add(key);
  } catch {
    // No package.json, or one that does not parse: nothing to check against.
  }

  try {
    const raw = await safeReadFile(projectDir, join(projectDir, "Makefile"), { maxBytes: MAX_MANIFEST_BYTES });
    for (const line of raw.split("\n")) {
      const target = /^([A-Za-z0-9_.-]+)[ \t]*:(?!=)/.exec(line);
      if (target && target[1] !== ".PHONY") makeTargets.add(target[1]);
    }
  } catch {
    // No Makefile.
  }

  return { scripts, makeTargets };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a missing path is worth reporting.
 *
 * A path with a file extension was a real file once. A path whose first segment
 * still exists is a real location that lost its contents. Anything else —
 * `foo/bar` in a repo with no `foo` — is far more likely an example than a
 * stale reference, and reporting it would cost precision for nothing.
 */
async function isConcretePath(ref: string, projectDir: string): Promise<boolean> {
  if (/\.[A-Za-z0-9]{1,8}$/.test(ref)) return true;
  const root = ref.split("/")[0];
  return root.length > 0 && await exists(join(projectDir, root));
}

export async function findStaleRefs(
  lines: readonly InstructionLine[],
  projectDir: string,
  opts: { facts?: RepoFacts } = {},
): Promise<StaleRef[]> {
  const facts = opts.facts ?? await readRepoFacts(projectDir);
  const out: StaleRef[] = [];
  const resolvedProject = resolve(projectDir);

  for (const line of lines) {
    // Only instructions about this repository can be checked against it.
    if (line.source.scope !== "project") continue;

    for (const ref of extractRefs(line.text)) {
      const script = scriptRef(ref);
      if (script) {
        const known = script.manager === "npm" ? facts.scripts : facts.makeTargets;
        // An empty manifest means "not checkable", not "every target is missing".
        if (known.size === 0 || known.has(script.target)) continue;
        out.push({
          line,
          ref,
          kind: "script",
          detail: script.manager === "npm"
            ? `package.json has no "${script.target}" script`
            : `the Makefile has no "${script.target}" target`,
        });
        continue;
      }

      if (!isPathShaped(ref)) continue;
      if (IGNORED_ROOTS.has(ref.split("/")[0])) continue;
      const full = join(resolvedProject, ref);
      // Containment: a `../` reference leaves the project and is not ours to check.
      if (!resolve(full).startsWith(resolvedProject)) continue;
      if (await exists(full)) continue;
      if (!await isConcretePath(ref, resolvedProject)) continue;
      out.push({ line, ref, kind: "path", detail: `no such file or directory in this repository` });
    }
  }

  return out;
}
