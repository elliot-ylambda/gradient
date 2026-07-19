import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { LLMBackend, LLMRequest } from "./backend.js";

export interface CodexRunResult { code: number; stdout: string; stderr: string }
type RunFn = (
  cmd: string,
  args: string[],
  input: string,
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) => Promise<CodexRunResult>;
type WhichFn = (bin: string) => Promise<string | null>;
const OUTPUT_MAX_CHARS = 2_000_000;
const WHICH_OUTPUT_MAX_CHARS = 8_192;
const WHICH_TIMEOUT_MS = 3_000;

const defaultRun: RunFn = (cmd, args, input, opts) => new Promise(resolveP => {
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"], cwd: opts?.cwd, env: opts?.env, signal: opts?.signal,
  });
  let stdout = "", stderr = "";
  const collect = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString();
    if (next.length > OUTPUT_MAX_CHARS) {
      child.kill();
      return next.slice(0, OUTPUT_MAX_CHARS);
    }
    return next;
  };
  child.stdout.on("data", chunk => (stdout = collect(stdout, chunk)));
  child.stderr.on("data", chunk => (stderr = collect(stderr, chunk)));
  child.on("error", error => resolveP({ code: 1, stdout: "", stderr: error.message }));
  child.on("close", code => resolveP({ code: code ?? 1, stdout, stderr }));
  child.stdin.on("error", () => {});
  child.stdin.write(input);
  child.stdin.end();
});

const defaultWhich: WhichFn = bin => new Promise(resolveP => {
  const child = spawn(process.platform === "win32" ? "where" : "which", [bin], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  let settled = false;
  const finish = (value: string | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveP(value);
  };
  const timer = setTimeout(() => {
    child.kill();
    finish(null);
  }, WHICH_TIMEOUT_MS);
  child.stdout.on("data", chunk => {
    stdout += chunk.toString();
    if (stdout.length > WHICH_OUTPUT_MAX_CHARS) {
      child.kill();
      finish(null);
    }
  });
  child.on("close", code => finish(code === 0 && stdout.trim() ? stdout.trim().split("\n")[0] : null));
  child.on("error", () => finish(null));
});

const DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "browser_use", "browser_use_external",
  "browser_use_full_cdp_access", "computer_use", "apps", "enable_mcp_apps",
  "image_generation", "multi_agent", "multi_agent_v2", "enable_fanout",
  "hooks", "plugins", "remote_plugin", "plugin_sharing", "auth_elicitation",
  "tool_call_mcp_elicitation", "request_permissions_tool", "code_mode",
  "code_mode_host", "code_mode_only", "memories", "network_proxy",
  "workspace_dependencies", "skill_mcp_dependency_install", "goals", "tool_suggest",
];

/** Isolated text-to-text backend using the user's existing Codex login. */
export class CodexCliBackend implements LLMBackend {
  name = "codex-cli";
  private runFn: RunFn;
  private whichFn: WhichFn;
  private model?: string;
  readonly spawnCwd?: string;
  private executable?: string;

  constructor(deps: { runFn?: RunFn; whichFn?: WhichFn; model?: string; spawnCwd?: string } = {}) {
    this.runFn = deps.runFn ?? defaultRun;
    this.whichFn = deps.whichFn ?? defaultWhich;
    this.model = deps.model;
    this.spawnCwd = deps.spawnCwd;
  }

  async available(): Promise<boolean> {
    try {
      const found = await this.whichFn("codex");
      if (!found || !isAbsolute(found)) return false;
      this.executable = await realpath(found);
      return true;
    } catch {
      return false;
    }
  }

  async complete(req: LLMRequest): Promise<string> {
    if (!this.executable && !(await this.available())) {
      throw new Error("Codex CLI is unavailable or did not resolve to an absolute path");
    }
    const args = [
      "exec", "--strict-config", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never",
      "--ask-for-approval", "never",
      "--config", "project_doc_max_bytes=0",
    ];
    for (const feature of DISABLED_FEATURES) args.push("--disable", feature);
    if (this.model) args.push("--model", this.model);
    args.push("-");
    const input = [
      "Follow the SYSTEM INSTRUCTIONS below as the highest-priority task instructions.",
      "This is a text-to-text classification request. Do not inspect files, run commands, browse, or use tools.",
      "Return only the requested final text.", "", "<SYSTEM_INSTRUCTIONS>", req.system,
      "</SYSTEM_INSTRUCTIONS>", "", "<UNTRUSTED_INPUT>", req.prompt, "</UNTRUSTED_INPUT>",
    ].join("\n");
    const privateCwd = this.spawnCwd ?? await mkdtemp(join(tmpdir(), "gradient-codex-"));
    try {
      const { code, stdout, stderr } = await this.runFn(this.executable!, args, input, {
        cwd: privateCwd,
        env: { ...process.env, GRADIENT_AUTOPILOT_CHILD: "1" },
        signal: req.signal,
      });
      if (code !== 0) throw new Error(`Codex CLI failed (${code}): ${stderr}`);
      return stdout.trim();
    } finally {
      if (!this.spawnCwd) await rm(privateCwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
