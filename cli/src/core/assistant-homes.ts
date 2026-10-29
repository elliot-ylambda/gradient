import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DiscoveryOptions {
  home?: string;
  codexHome?: string;
  claudeHome?: string;
}

/** Explicit fixture homes stay isolated from the process's real configuration. */
export function assistantHomes(opts: DiscoveryOptions = {}): { home: string; codex: string; claude: string } {
  const home = resolve(opts.home ?? homedir());
  const live = home === resolve(homedir());
  return {
    home,
    codex: resolve(opts.codexHome ?? (live ? process.env.CODEX_HOME : undefined) ?? join(home, ".codex")),
    claude: resolve(opts.claudeHome ?? (live ? process.env.CLAUDE_CONFIG_DIR : undefined) ?? join(home, ".claude")),
  };
}
