import { readFile, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const dir = await mkdtemp(join(tmpdir(), "gradient-bin-smoke-"));
const link = join(dir, "gradient");
await symlink(join(root, "dist", "bin.js"), link);

const result = process.platform === "win32"
  ? spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" })
  : spawnSync(link, ["--version"], { encoding: "utf8" });
if (result.status !== 0 || result.stdout.trim() !== pkg.version || result.stderr) {
  process.stderr.write(`bin smoke failed: status=${result.status} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}\n`);
  process.exit(1);
}
process.stdout.write(`gradient ${pkg.version} bin smoke passed\n`);
