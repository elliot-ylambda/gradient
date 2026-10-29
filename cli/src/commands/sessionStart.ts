import { loadConfig, projectKey, supportsClaudeHooks } from "../config.js";
import { displayCommand } from "../core/hookBinary.js";
import { stripUnsafeControls } from "../core/security.js";
import { loadLastCheckup } from "./optimize.js";

export interface SessionStartDeps {
  home?: string;
  loadLastCheckupFn?: typeof loadLastCheckup;
  write?: (line: string) => void;
}

function oneLine(value: string): string {
  return stripUnsafeControls(value).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** Surface the last ranked checkup. SessionEnd alone schedules new work. */
export async function sessionStart(projectDir: string, deps: SessionStartDeps = {}): Promise<void> {
  try {
    const config = await loadConfig(deps.home);
    if (!supportsClaudeHooks(config) || !config.optimizeProjects?.includes(projectKey(projectDir))) return;
    const checkup = await (deps.loadLastCheckupFn ?? loadLastCheckup)(projectDir, { home: deps.home });
    const finding = checkup?.findings[0];
    if (!finding) return;
    const line = `gradient checkup (${checkup!.checkedAt.slice(0, 10)}): ` +
      `${oneLine(finding.title)} — review with ${displayCommand()} optimize`;
    (deps.write ?? (value => process.stdout.write(`${value}\n`)))(line);
  } catch {
    // Stale callbacks, unreadable state, and broken streams never block startup.
  }
}
