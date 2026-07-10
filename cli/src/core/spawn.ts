import { spawn as realSpawn } from "node:child_process";
import { join } from "node:path";
import { gradientDir } from "./manifest.js";
import { safeOpenAppendSync } from "./safeFs.js";

type SpawnFn = typeof realSpawn;

export interface SpawnDeps {
  spawn?: SpawnFn;
  openLog?: (path: string) => number;
}

/**
 * Launch the gradient CLI in the background (detached) so a session-start hook
 * returns immediately. stdout/stderr go to .gradient/last-scan.log so a failed
 * background run is still diagnosable (never silent).
 */
export function spawnDetached(args: string[], projectDir: string, deps: SpawnDeps = {}): void {
  const spawn = deps.spawn ?? realSpawn;
  const logPath = join(gradientDir(projectDir), "last-scan.log");
  const fd = deps.openLog ? deps.openLog(logPath) : safeOpenAppendSync(projectDir, logPath);
  const child = spawn(process.execPath, [process.argv[1], ...args], {
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
}
