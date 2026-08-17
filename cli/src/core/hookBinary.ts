import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED } from "../version.js";

/**
 * The command a pre-0.8 install wrote, back when gradient was an npm package and
 * `npm i -g gradient.md` put a `gradient` on PATH. Nothing writes it any more —
 * gradient ships as a plugin or a copied skill directory, neither of which
 * touches PATH — but `off` still has to recognise it to remove those hooks from
 * the machines that already have them.
 */
const LEGACY_PATH_BINARY = "gradient";

/** Quote for a POSIX shell only when the value actually needs it. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * gradient's own runnable entry point.
 *
 * Located from this module rather than from process.argv — argv[1] is the *host*
 * process (a test runner, or any program embedding this package), which must
 * never be baked into a user's hook.
 *
 * The two builds keep the entry in different places, and that difference is the
 * whole reason this used to give up and shell out to npx. In the tsc build this
 * module is one file inside dist/ and the entry is dist/bin.js. In the bundle —
 * the plugin's bin/gradient.mjs, and the copy each installed skill carries —
 * every module is inlined, so this module IS the entry. Resolving only
 * `../bin.js` looked for plugin/bin.js, found nothing, and concluded gradient
 * was unreachable while running from the very file it was looking for.
 */
function ownBinPath(): string | null {
  const here = fileURLToPath(import.meta.url);
  // Bundled is the only shape gradient ships in — the plugin and every copied
  // skill directory carry the bundle — so the two candidates below are reached
  // only from a source checkout: dist/bin.js after a build, src/bin.ts when
  // vitest runs the sources directly. Both are genuinely where the program
  // starts for that tree; neither can end up in a released artifact.
  const candidates = BUNDLED
    ? [here]
    : [join(dirname(here), "..", "bin.js"), join(dirname(here), "..", "bin.ts")];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Not this one.
    }
  }
  return null;
}

/**
 * The command prefix an installed hook should run.
 *
 * There is exactly one honest answer now: this node, running this install's own
 * entry point. No PATH lookup, because nothing puts `gradient` on PATH. No npx
 * fallback, because there is no package to fetch — and because that fallback was
 * silently broken: it pinned hooks to `npx -y gradient.md@<version>`, a registry
 * coordinate that need not exist for the build doing the pinning, and hooks have
 * nowhere to report a failure.
 *
 * The resolved path is stable across upgrades. Claude Code re-clones a plugin in
 * place at `~/.claude/plugins/cache/<marketplace>/<plugin>`, and a copied skill
 * directory is the user's own. It stops resolving only when gradient is removed,
 * which is when a gradient hook should stop resolving.
 */
export function gradientCommand(opts: { execPath?: string; scriptPath?: string | null } = {}): string {
  const scriptPath = opts.scriptPath === undefined ? ownBinPath() : opts.scriptPath;
  if (!scriptPath) {
    throw new Error(
      "cannot locate gradient's own entry point, so any hook written now would never run — reinstall the gradient plugin or skill",
    );
  }
  return `${shellQuote(opts.execPath ?? process.execPath)} ${shellQuote(scriptPath)}`;
}

/** The command an installed hook should run for one gradient subcommand. Every
 *  hook installer must go through this rather than composing `gradient <sub>`,
 *  which resolves nowhere. */
export function gradientHookCommand(
  subcommand: string,
  opts: Parameters<typeof gradientCommand>[0] = {},
): string {
  return `${gradientCommand(opts)} ${subcommand}`;
}

/**
 * Whether an installed hook command is gradient's own invocation of a subcommand.
 *
 * Removal cannot compare against a freshly resolved string: a hook installed
 * from one location reads `<node> <that script> recall`, while `off` run from
 * another would resolve somewhere else and match nothing, silently orphaning the
 * hook. Match on the subcommand instead, still requiring the command to name
 * gradient so a user's unrelated hook is never removed.
 */
export function isGradientHookFor(command: string, subcommand: string): boolean {
  const trimmed = command.trim();
  const targetsSubcommand = trimmed === `${LEGACY_PATH_BINARY} ${subcommand}` ||
    trimmed.endsWith(` ${subcommand}`);
  return targetsSubcommand && /gradient/i.test(trimmed);
}

let displayCache: string | undefined;

/** Whether a bare command name resolves to something executable. */
function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // Not in this entry; keep looking.
    }
  }
  return false;
}

/**
 * How to tell the reader to run gradient again.
 *
 * The same command a hook gets, shortened for a human without ceasing to be the
 * command: nothing puts `gradient` on PATH any more, so a printed
 * `gradient optimize --apply <id>` is one the reader cannot run.
 *
 * Two shortenings, both of which a shell undoes exactly:
 *
 * - `node`, when a `node` on PATH exists to undo it. A hook cannot assume that
 *   — it runs with a minimal environment and no shell profile — but a person
 *   reading a report has the shell that just printed it.
 * - `~` for the home prefix. Shorter, and it keeps gradient from printing the
 *   user's account name into a report they may well paste somewhere. Tilde
 *   expansion is not word-split, so this survives a home directory with a space
 *   in it — but the rest of the path is, so anything needing quotes stays
 *   absolute rather than becoming a command that silently splits in two.
 *
 * Terminal output only. Anything gradient writes *into* a user's repository — a
 * rule's removal comment, the playbook header — names the verb with no path at
 * all, because those files are shared and a home directory is not portable.
 */
export function displayCommand(opts: { execPath?: string; scriptPath?: string | null; home?: string; env?: NodeJS.ProcessEnv } = {}): string {
  if (displayCache !== undefined && Object.keys(opts).length === 0) return displayCache;

  const absolute = gradientCommand(opts);
  const scriptPath = opts.scriptPath ?? ownBinPath();
  const home = opts.home ?? homedir();
  const execPath = opts.execPath ?? process.execPath;

  let command = absolute;
  if (scriptPath?.startsWith(home + sep)) {
    // Test the part after the tilde, not the whole string: `~` is not a
    // shell-safe character, so quoting the tilde-prefixed path always differs
    // from it — and quoting the tilde is exactly what stops it expanding.
    const rest = scriptPath.slice(home.length);
    if (shellQuote(rest) === rest) {
      const node = onPath("node", opts.env ?? process.env) ? "node" : shellQuote(execPath);
      command = `${node} ~${rest}`;
    }
  }
  if (Object.keys(opts).length === 0) displayCache = command;
  return command;
}
