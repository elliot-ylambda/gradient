import { spawn as realSpawn } from "node:child_process";
import { closeSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { gradientDir } from "./manifest.js";
import { safeOpenWriteSync } from "./safeFs.js";

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
  const fd = deps.openLog ? deps.openLog(logPath) : safeOpenWriteSync(projectDir, logPath);
  try {
    const entrypoint = realpathSync(process.argv[1]);
    const child = spawn(process.execPath, [entrypoint, ...args], {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    child.unref();
  } finally {
    // spawn duplicates the descriptor into the child. Keep no parent-side log
    // descriptor open; injected test descriptors remain owned by the caller.
    if (!deps.openLog) closeSync(fd);
  }
}
