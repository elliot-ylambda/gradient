import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { VERSION } from "../version.js";

/** What a hook command looks like when `gradient` is a real command on PATH. */
export const DEFAULT_HOOK_BINARY = "gradient";

/** npx materializes a package under a cache directory it is free to evict. A
 *  hook pinned there keeps working until the cache is cleaned and then fails
 *  with status 127 — silently, because hooks have nowhere to report. */
const EPHEMERAL_INSTALL = /[\\/]_npx[\\/]/;

export interface HookBinary {
  /** Command prefix; callers append the subcommand. */
  command: string;
  /** True when the command should keep resolving after this process exits. */
  durable: boolean;
  /** Set whenever the command is anything other than a bare `gradient`. */
  warning?: string;
}

/** Quote for a POSIX shell only when the value actually needs it. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  const raw = env.PATH ?? env.Path;
  if (!raw) return false;
  for (const dir of raw.split(delimiter)) {
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
 * Decide how an installed hook should invoke gradient.
 *
 * Writing a bare `gradient` is correct only when `gradient` is on PATH. Anyone
 * who reached this CLI through `npx gradient.md` has no such command, so a bare
 * name produces a hook that exits 127 on every fire — and Claude Code surfaces
 * nothing, so the failure is invisible. Resolve it at install time instead.
 */
export function resolveHookBinary(opts: {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  scriptPath?: string;
  version?: string;
} = {}): HookBinary {
  const env = opts.env ?? process.env;
  if (onPath(DEFAULT_HOOK_BINARY, env)) return { command: DEFAULT_HOOK_BINARY, durable: true };

  const execPath = opts.execPath ?? process.execPath;
  const scriptPath = opts.scriptPath ?? process.argv[1];
  if (scriptPath && !EPHEMERAL_INSTALL.test(scriptPath)) {
    return {
      command: `${shellQuote(execPath)} ${shellQuote(scriptPath)}`,
      durable: true,
      warning: `gradient is not on PATH, so the hook was pinned to this install: ${scriptPath}. ` +
        `Install globally (npm i -g gradient.md) and re-apply for a portable hook.`,
    };
  }

  const spec = `gradient.md@${opts.version ?? VERSION}`;
  return {
    command: `npx -y ${spec}`,
    durable: false,
    warning: `gradient is not on PATH and this process runs from a temporary npx cache, ` +
      `so the hook falls back to "npx -y ${spec}" — slower per fire, and it needs the npm cache. ` +
      `Install globally (npm i -g gradient.md) and re-apply for a direct command.`,
  };
}
