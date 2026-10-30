import { basename, dirname, join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { git } from "./board.js";
import { within } from "./discovery.js";
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
const MAX_MANIFESTS = 200;
const MAX_INDEX_BYTES = 32_000_000;
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

/** The words an author reaches for when a path is an example, not a file:
 *  `path/to/x.ts`, `your-test.test.ts`, `test_specific_test.py`, `YYYY-MM-DD.md`. */
const PLACEHOLDER = /(^|\/)path\/to\/|(^|[/_.-])(your|example|specific|sample|placeholder)([/_.-]|$)|yyyy|\bmm-dd\b/i;

/** "(example: `src/a.ts:80`)", "e.g. `utils/x.test.ts`": the path on such a
 *  line is there to show a shape. */
const EXAMPLE_LINE = /\be\.g\.|\bfor (?:example|instance)\b|\bexample:/i;

/** Anything with a placeholder, glob, or scheme is illustrative rather than a
 *  concrete reference. */
function isIllustrative(ref: string): boolean {
  return /[*?<>${}]/.test(ref) || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref) || /^mailto:/i.test(ref) ||
    ref.includes("...") || PLACEHOLDER.test(ref);
}

/** A letter-bearing suffix after a name: `.ts`, `.env.local`; not the `.0` of
 *  `release-2.0`, and not a dot-directory such as `.local/`. */
function hasFileExtension(ref: string): boolean {
  const extension = /[^/.]\.([A-Za-z0-9]{1,8})$/.exec(ref)?.[1];
  return extension !== undefined && /[A-Za-z]/.test(extension);
}

/** What a reference names on disk: `@path` is Claude's import syntax, and a
 *  `:12` line or `#anchor` locates something inside the file. */
function onDisk(ref: string): string {
  return ref.replace(/^@/, "").replace(/[#?].*$/, "").replace(/:\d+(?::\d+)?$/, "").replace(/^\.\//, "").replace(/\/$/, "");
}

/** Quotes and parentheses around a token, and the punctuation prose puts after it. */
function unwrap(token: string): string {
  return token.replace(/^["'(]+/, "").replace(/[.,;:)"']+$/, "");
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

/** Markdown link targets, backticked spans, plus bare tokens that look like a
 *  file. Prose is not scanned for loose words: only forms an author marked as a
 *  literal. */
export function extractRefs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const ref = unwrap(value.trim());
    // Applied to backticked spans too: an author who writes `src/**/*.ts` is
    // describing a shape, not naming a file that ought to exist.
    if (!ref || isIllustrative(ref) || seen.has(ref) || out.length >= MAX_REFS_PER_LINE) return;
    seen.add(ref);
    out.push(ref);
  };

  // A link is read as its target. Split on whitespace, `[upgrade guide](docs/x.md)`
  // became the token `guide](docs/x.md` — never a file — so every link with a
  // multi-word label was reported gone, with a fix that deleted the line.
  let rest = text.replace(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_link, target: string) => {
    push(target);
    return " ";
  });
  for (const match of rest.matchAll(/`([^`]+)`/g)) {
    const span = match[1];
    push(span);
    // A backticked span is pushed whole so `npm run build` can be recognised as
    // a script reference. When it is a command rather than a bare path, the
    // path inside it would otherwise never be checked: `isPathShaped` rejects
    // anything containing a space, so "Run `node scripts/build.mjs` first" —
    // one of the most common shapes a CLAUDE.md takes — was invisible to the
    // one family whose job is keeping those lines true.
    //
    // Still precise: each token has to look like a path on its own, and
    // `isConcretePath` then discards the ones that only resemble one
    // (`origin/main`, a `sed` expression) because their parent directory does
    // not exist in the repository either.
    if (/\s/.test(span)) {
      for (const token of span.split(/\s+/)) {
        if (isPathShaped(token)) push(token);
      }
    }
    rest = rest.replace(match[0], " ");
  }
  // Unmarked prose is full of slashes — "test/CI", "security/API", "Docs/user-visible" —
  // so a bare token has to name a file before it is read as one.
  for (const token of rest.split(/\s+/)) {
    const ref = unwrap(token);
    if (isPathShaped(ref) && hasFileExtension(onDisk(ref))) push(ref);
  }
  return out;
}

/** The checkup reads repositories it did not write. A repository's own
 *  `.git/config` can name a `core.fsmonitor` command that an untracked-file
 *  listing runs; never let it. */
const UNTRUSTED_REPO = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

/** Every file git would show for this checkout, tracked or not, minus ignored
 *  ones, and the files of its submodules — an instruction about a vendored fork
 *  names `run/attempt.ts` inside it. Null outside a repository or when the
 *  listing is unavailable. */
export async function repoIndex(projectDir: string): Promise<string[] | null> {
  const listed = await git([...UNTRUSTED_REPO, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], projectDir, MAX_INDEX_BYTES);
  if (listed === null) return null;
  // `--recurse-submodules` only combines with `--cached`, hence a second listing.
  const nested = await git([...UNTRUSTED_REPO, "ls-files", "-z", "--cached", "--recurse-submodules"], projectDir, MAX_INDEX_BYTES);
  return [...new Set(`${listed}\0${nested ?? ""}`.split("\0").filter(Boolean))];
}

/** Scripts and targets from the root manifests and, in a workspace, every
 *  package's: "run `bun run generate` from `packages/client`" names a script
 *  the root package.json never had. */
export async function readRepoFacts(projectDir: string, index: string[] | null = null): Promise<RepoFacts> {
  const scripts = new Set<string>();
  const makeTargets = new Set<string>();
  const nested = (name: string) => (index ?? []).filter(file => file !== name && basename(file) === name).slice(0, MAX_MANIFESTS);

  for (const file of ["package.json", ...nested("package.json")]) {
    try {
      const raw = await safeReadFile(projectDir, join(projectDir, file), { maxBytes: MAX_MANIFEST_BYTES });
      const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
      for (const key of Object.keys(parsed.scripts ?? {})) scripts.add(key);
    } catch {
      // No package.json, or one that does not parse: nothing to check against.
    }
  }

  for (const file of ["Makefile", ...nested("Makefile")]) {
    try {
      const raw = await safeReadFile(projectDir, join(projectDir, file), { maxBytes: MAX_MANIFEST_BYTES });
      for (const line of raw.split("\n")) {
        const target = /^([A-Za-z0-9_.-]+)[ \t]*:(?!=)/.exec(line);
        if (target && target[1] !== ".PHONY") makeTargets.add(target[1]);
      }
    } catch {
      // No Makefile.
    }
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
 * A path with a file extension was a real file once. A path whose parent still
 * exists is a real location that lost its contents. Anything else — `foo/bar`
 * in a repo with no `foo`, the route `gateway/api/chat` beside a `gateway/`
 * with no `api/` — is far more likely an example than a stale reference, and
 * reporting it would cost precision for nothing.
 */
async function isConcretePath(ref: string, bases: readonly string[]): Promise<boolean> {
  // An all-digit suffix is a version, not a file extension. `origin/release-2.0`
  // is path-shaped and ends in ".0", so it read as a missing file — and this
  // family proposing the deletion of a correct instruction is the one outcome
  // its precision rules exist to prevent.
  if (hasFileExtension(ref)) return true;
  const parent = dirname(ref);
  if (parent === ".") return false;
  for (const base of bases) if (await exists(join(base, parent))) return true;
  return false;
}

/** Whether some file in the repository is what the reference names when read
 *  from a subdirectory: a CLAUDE.md section about `webapp/` says `src/lib/auth.ts`. */
function namedSomewhere(ref: string, index: readonly string[]): boolean {
  const slashed = `/${ref}`;
  return index.some(file => {
    const path = `/${file}`;
    return path.endsWith(slashed) || path.includes(`${slashed}/`);
  });
}

export async function findStaleRefs(
  lines: readonly InstructionLine[],
  projectDir: string,
  opts: { facts?: RepoFacts; index?: string[] | null } = {},
): Promise<StaleRef[]> {
  const resolvedProject = resolve(projectDir);
  const index = opts.index !== undefined ? opts.index : await repoIndex(resolvedProject);
  const facts = opts.facts ?? await readRepoFacts(projectDir, index);
  const out: StaleRef[] = [];
  const missing: Array<{ ref: StaleRef; path: string }> = [];

  for (const line of lines) {
    // Only instructions about this repository can be checked against it.
    if (line.source.scope !== "project") continue;
    const example = EXAMPLE_LINE.test(line.text);

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

      if (example || !isPathShaped(ref)) continue;
      const path = onDisk(ref);
      if (!path || IGNORED_ROOTS.has(path.split("/")[0])) continue;
      // A path resolves from the repository root or, as a link does, from the
      // instruction file's own directory. Containment by whole segment: a
      // `../openclaw.ai` beside `openclaw` leaves the project and is not ours.
      const bases = [...new Set([resolvedProject, dirname(resolve(line.source.path))])]
        .filter(base => within(resolvedProject, resolve(base, path)));
      if (bases.length === 0) continue;
      if ((await Promise.all(bases.map(base => exists(resolve(base, path))))).some(Boolean)) continue;
      if (!await isConcretePath(path, bases)) continue;
      missing.push({ ref: { line, ref, kind: "path", detail: `no such file or directory in this repository` }, path });
    }
  }

  // Missing from both places is still not gone: the file may live deeper in the
  // tree, or be build output git ignores (`.env.local`, a generated report).
  let gone = missing;
  if (index) {
    gone = gone.filter(item => !namedSomewhere(item.path, index));
    // A directory-only pattern (`.local/`) matches a missing path only when it
    // is asked about as a directory.
    const paths = [...new Set(gone.flatMap(item => hasFileExtension(item.path) ? [item.path] : [item.path, `${item.path}/`]))];
    // `-z` needs --stdin, which this helper cannot feed; unquoted paths instead.
    const ignored = paths.length === 0 ? null
      : await git([...UNTRUSTED_REPO, "-c", "core.quotePath=false", "check-ignore", "--no-index", "--", ...paths], resolvedProject);
    const skip = new Set((ignored ?? "").split("\n").filter(Boolean));
    gone = gone.filter(item => !skip.has(item.path) && !skip.has(`${item.path}/`));
  }
  out.push(...gone.map(item => item.ref));
  return out;
}
