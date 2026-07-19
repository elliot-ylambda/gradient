#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, release, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(scriptDir, "..");
const repoRoot = resolve(cliDir, "..");
const OUTPUT_CAP = 32_000;
const SECRET_SENTINEL = `npm_${"z".repeat(36)}`;
const LIVE_LIMITATIONS = [
  "Synthetic histories are used; no personal Claude Code or Codex history is read.",
  "Deterministic local stand-ins exercise CLI protocols; no real model response or credit spend is observed.",
  "The notification hook is proven fail-open, but no desktop notification is visually observed.",
  "The non-TTY installed binary is exercised automatically; interactive terminal presentation remains a live check.",
];

const COVERED_COMMANDS = new Set([
  "<bare>", "help", "init", "scan", "review", "session-start", "apply", "explain",
  "notify", "list", "remove", "migrate", "recall", "stats", "insights", "continuity",
  "recap", "bundle", "checkpoint", "autopilot", "respond",
]);

function parseOptions(argv) {
  let output = join(repoRoot, "artifacts", "dogfood");
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") {
      keep = true;
    } else if (arg === "--output") {
      const value = argv[index + 1];
      if (!value) throw new Error("--output needs a directory");
      output = resolve(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node scripts/dogfood.mjs [--output <directory>] [--keep]\n" +
        "Runs packaged synthetic dogfood scenarios and writes JSON, Markdown, and HTML evidence.\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown dogfood option: ${arg}`);
    }
  }
  return { output, keep };
}

function cap(value) {
  const text = String(value ?? "");
  return text.length <= OUTPUT_CAP
    ? text
    : `${text.slice(0, OUTPUT_CAP)}\n… <output capped at ${OUTPUT_CAP} characters>`;
}

function shellArg(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parsePackJson(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error(`npm pack did not return JSON: ${cap(stdout)}`);
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  if (!Array.isArray(parsed) || !parsed[0]?.filename) throw new Error("npm pack returned no tarball");
  return parsed[0];
}

function publicCommandsFromHelp(help) {
  const commands = new Set();
  for (const line of help.split(/\r?\n/)) {
    const match = /^\s{2}gradient(?:( {1,3})([a-z][a-z-]*))?(?:\s|$)/.exec(line);
    if (match) commands.add(match[2] ?? "<bare>");
  }
  return commands;
}

function totals(cases) {
  return cases.reduce((out, item) => {
    out[item.status] += 1;
    return out;
  }, { passed: 0, failed: 0, skipped: 0 });
}

function renderMarkdown(report) {
  const count = report.totals;
  const lines = [
    "# Gradient dogfood evidence",
    "",
    `**Result:** ${report.result.toUpperCase()}  `,
    `**Package:** \`${report.package.name}@${report.package.version}\`  `,
    `**Commit:** \`${report.source.commit}\`  `,
    `**Tarball SHA-256:** \`${report.package.tarballSha256}\`  `,
    `**Runtime:** Node ${report.runtime.node} · ${report.runtime.platform} ${report.runtime.arch}`,
    "",
    "> This is deterministic synthetic packaged proof. It does not claim that a real personal history, paid model call, interactive TTY, or visible OS notification was observed.",
    "",
    `Passed ${count.passed}; failed ${count.failed}; skipped ${count.skipped}.`,
    "",
    "| Scenario | Area | Result | Duration |",
    "|---|---|---:|---:|",
    ...report.cases.map(item =>
      `| ${item.title.replaceAll("|", "\\|")} | ${item.area} | ${item.status.toUpperCase()} | ${item.durationMs} ms |`),
    "",
    "## Scenario evidence",
    "",
  ];
  for (const item of report.cases) {
    lines.push(`### ${item.status === "passed" ? "✓" : item.status === "failed" ? "✗" : "–"} ${item.title}`, "");
    if (item.error) lines.push(`Error: ${item.error}`, "");
    if (item.skipReason) lines.push(`Skipped: ${item.skipReason}`, "");
    if (item.assertions.length) {
      lines.push("Assertions:", "");
      for (const assertion of item.assertions) {
        lines.push(`- ${assertion.passed ? "✓" : "✗"} ${assertion.label}${assertion.details ? ` — ${assertion.details}` : ""}`);
      }
      lines.push("");
    }
    for (const command of item.commands) {
      lines.push(`<details><summary><code>${htmlEscape(command.command)}</code> — exit ${command.exitCode}</summary>`, "");
      if (command.stdout) lines.push("```text", command.stdout, "```", "");
      if (command.stderr) lines.push("stderr:", "```text", command.stderr, "```", "");
      lines.push("</details>", "");
    }
  }
  lines.push("## Automated-proof limitations", "", ...report.limitations.map(item => `- ${item}`), "");
  return `${lines.join("\n")}\n`;
}

function renderHtml(report) {
  const rows = report.cases.map(item => `
    <tr><td>${htmlEscape(item.title)}</td><td>${htmlEscape(item.area)}</td>
    <td><span class="pill ${item.status}">${htmlEscape(item.status)}</span></td><td>${item.durationMs} ms</td></tr>`).join("");
  const details = report.cases.map(item => {
    const assertions = item.assertions.map(assertion =>
      `<li class="${assertion.passed ? "ok" : "bad"}">${assertion.passed ? "✓" : "✗"} ${htmlEscape(assertion.label)}${assertion.details ? ` — ${htmlEscape(assertion.details)}` : ""}</li>`).join("");
    const commands = item.commands.map(command => `
      <details><summary><code>${htmlEscape(command.command)}</code> — exit ${command.exitCode}</summary>
      ${command.stdout ? `<h4>stdout</h4><pre>${htmlEscape(command.stdout)}</pre>` : ""}
      ${command.stderr ? `<h4>stderr</h4><pre>${htmlEscape(command.stderr)}</pre>` : ""}</details>`).join("");
    return `<section><h3>${item.status === "passed" ? "✓" : item.status === "failed" ? "✗" : "–"} ${htmlEscape(item.title)}</h3>
      ${item.error ? `<p class="bad">${htmlEscape(item.error)}</p>` : ""}
      ${item.skipReason ? `<p>${htmlEscape(item.skipReason)}</p>` : ""}<ul>${assertions}</ul>${commands}</section>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Gradient dogfood evidence</title><style>
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{max-width:1100px;margin:0 auto;padding:32px;line-height:1.5}
  h1,h2,h3{line-height:1.2}table{width:100%;border-collapse:collapse}th,td{padding:9px;border-bottom:1px solid #8886;text-align:left}
  .summary{padding:16px;border:1px solid #8886;border-radius:10px}.pill{font-weight:700;text-transform:uppercase}.passed,.ok{color:#18864b}.failed,.bad{color:#d13b3b}.skipped{color:#9a6b00}
  pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#8881;padding:12px;border-radius:8px}details{margin:8px 0}code{font-family:ui-monospace,SFMono-Regular,monospace}
  </style></head><body><h1>Gradient dogfood evidence</h1>
  <div class="summary"><strong>${htmlEscape(report.result.toUpperCase())}</strong> · ${report.totals.passed} passed · ${report.totals.failed} failed · ${report.totals.skipped} skipped<br>
  <code>${htmlEscape(report.package.name)}@${htmlEscape(report.package.version)}</code> · commit <code>${htmlEscape(report.source.commit)}</code><br>
  Tarball SHA-256 <code>${htmlEscape(report.package.tarballSha256)}</code></div>
  <p><strong>Synthetic packaged proof:</strong> this report does not claim a real private history, paid model call, interactive TTY, or visible desktop notification was observed.</p>
  <h2>Scenarios</h2><table><thead><tr><th>Scenario</th><th>Area</th><th>Result</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Evidence</h2>${details}<h2>Automated-proof limitations</h2><ul>${report.limitations.map(item => `<li>${htmlEscape(item)}</li>`).join("")}</ul>
  </body></html>\n`;
}

async function runProcess(command, args, opts = {}) {
  const started = Date.now();
  return new Promise(resolvePromise => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (exitCode, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: exitCode ?? 1,
        signal: signal ?? null,
        stdout: cap(stdout),
        stderr: cap(error ? `${stderr}${stderr ? "\n" : ""}${error.message}` : stderr),
        durationMs: Date.now() - started,
        timedOut,
      });
    };
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => finish(1, null, error));
    child.on("close", (code, signal) => finish(code, signal));
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 120_000);
  });
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  return false;
}

function baseSuggestion(id, name, payload, extra = {}) {
  return {
    id,
    name,
    title: `Synthetic dogfood artifact: ${name}`,
    rationale: "Invented deterministic evidence for packaged dogfood validation.",
    evidence: {
      count: 4,
      sessions: 2,
      assistants: ["claude-code", "codex"],
      estMinutesSavedPerMonth: 18,
    },
    confidence: "high",
    examples: [`prepare the synthetic ${name} workflow`],
    sourceSignatures: [`synthetic ${name} workflow`],
    payload,
    ...extra,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), "gradient-dogfood-")));
  const state = {
    sandbox,
    output: options.output,
    packDir: join(sandbox, "pack"),
    consumer: join(sandbox, "consumer"),
    home: join(sandbox, "gradient-home"),
    project: join(sandbox, "project"),
    fakeBin: join(sandbox, "fake-bin"),
    cliBin: "",
    pluginBin: join(repoRoot, "plugin", "bin", "gradient.mjs"),
    package: { name: "gradient.md", version: "unknown", tarballSha256: "unknown", tarball: "" },
    sourceCommit: "unknown",
    productEnv: undefined,
    claudeTranscript: "",
    cases: [],
  };
  const status = new Map();
  let activeCase;
  // `npm publish --dry-run` exports npm_config_dry_run=true to lifecycle
  // children. The dogfood child must still materialize its disposable tarball
  // and consumer install or the release gate would become a simulation.
  const npmEnv = {
    ...process.env,
    npm_config_dry_run: "false",
    NPM_CONFIG_DRY_RUN: "false",
  };

  const replacements = () => [
    [state.home, "<gradient-home>"],
    [state.project, "<project>"],
    [state.consumer, "<consumer>"],
    [state.packDir, "<pack>"],
    [state.sandbox, "<sandbox>"],
    [repoRoot, "<source>"],
    [homedir(), "<host-home>"],
  ].filter(([from]) => from).sort((left, right) => right[0].length - left[0].length);

  const sanitize = value => {
    let text = cap(value);
    for (const [from, to] of replacements()) text = text.replaceAll(from, to);
    return text;
  };

  const command = async (display, executable, args, opts = {}) => {
    const result = await runProcess(executable, args, opts);
    const evidence = {
      command: sanitize(display),
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      stdout: sanitize(result.stdout.trimEnd()),
      stderr: sanitize(result.stderr.trimEnd()),
      timedOut: result.timedOut,
    };
    activeCase?.commands.push(evidence);
    return { ...result, stdout: result.stdout, stderr: result.stderr };
  };

  const runCli = (args, opts = {}) => command(
    ["gradient", ...args].map(shellArg).join(" "),
    process.execPath,
    [state.cliBin, ...args],
    { cwd: state.project, env: state.productEnv, input: opts.input, timeoutMs: opts.timeoutMs },
  );

  const runPlugin = args => command(
    ["plugin-gradient", ...args].map(shellArg).join(" "),
    process.execPath,
    [state.pluginBin, ...args],
    { cwd: state.project, env: state.productEnv },
  );

  const assertion = (condition, label, details = "") => {
    const record = { passed: Boolean(condition), label: sanitize(label), ...(details ? { details: sanitize(details) } : {}) };
    activeCase.assertions.push(record);
    if (!condition) throw new Error(`${label}${details ? `: ${details}` : ""}`);
  };

  const equal = (actual, expected, label) => assertion(
    isDeepStrictEqual(actual, expected),
    label,
    isDeepStrictEqual(actual, expected) ? "" : `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  );

  const scenario = async (id, title, area, fn, dependencies = []) => {
    const failedDependency = dependencies.find(dependency => status.get(dependency) !== "passed");
    if (failedDependency) {
      const item = {
        id, title, area, status: "skipped", durationMs: 0,
        skipReason: `dependency ${failedDependency} did not pass`, assertions: [], commands: [],
      };
      state.cases.push(item);
      status.set(id, "skipped");
      return;
    }
    const item = { id, title, area, status: "passed", durationMs: 0, assertions: [], commands: [] };
    state.cases.push(item);
    activeCase = item;
    const started = Date.now();
    try {
      await fn({ assertion, equal });
    } catch (error) {
      item.status = "failed";
      item.error = sanitize(error instanceof Error ? error.message : String(error));
    } finally {
      item.durationMs = Date.now() - started;
      activeCase = undefined;
      status.set(id, item.status);
    }
  };

  const configPath = join(state.home, ".config", "gradient", "config.json");
  const projectCacheDir = async () => {
    const canonical = await realpath(state.project);
    return join(state.home, ".config", "gradient", "projects", sha256(canonical).slice(0, 24));
  };
  const suggestionsPath = async () => join(await projectCacheDir(), "suggestions.json");
  const seedSuggestions = async suggestions => writeJson(await suggestionsPath(), suggestions);
  const updateConfig = async patch => {
    const current = await pathExists(configPath) ? await readJson(configPath) : {};
    await writeJson(configPath, { ...current, ...patch });
  };

  try {
    await scenario("package", "Pack and install the release artifact", "distribution", async ({ assertion, equal }) => {
      await mkdir(state.packDir, { recursive: true });
      await mkdir(state.consumer, { recursive: true });
      await writeJson(join(state.consumer, "package.json"), { private: true, name: "gradient-dogfood-consumer", version: "1.0.0" }, 0o644);

      const git = await command("git rev-parse HEAD", "git", ["rev-parse", "HEAD"], { cwd: repoRoot, env: process.env });
      if (git.exitCode === 0) state.sourceCommit = git.stdout.trim();

      const packed = await command(
        "npm pack --ignore-scripts --json --pack-destination <pack>",
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", state.packDir],
        { cwd: cliDir, env: npmEnv },
      );
      equal(packed.exitCode, 0, "npm pack succeeds without lifecycle scripts");
      const info = parsePackJson(packed.stdout);
      state.package.name = info.name;
      state.package.version = info.version;
      state.package.tarball = join(state.packDir, info.filename);
      state.package.tarballSha256 = sha256(await readFile(state.package.tarball));
      const packedPaths = new Set((info.files ?? []).map(file => file.path));
      assertion(packedPaths.has("dist/bin.js"), "tarball contains the executable");
      assertion(packedPaths.has("src/skill/SKILL.md"), "tarball contains the bundled Gradient skill");

      const installed = await command(
        "npm install --offline --ignore-scripts --no-audit --no-fund <tarball>",
        "npm",
        ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", state.package.tarball],
        { cwd: state.consumer, env: npmEnv, timeoutMs: 180_000 },
      );
      equal(installed.exitCode, 0, "fresh consumer installs the local tarball offline");
      state.cliBin = join(state.consumer, "node_modules", "gradient.md", "dist", "bin.js");
      const metadata = await stat(state.cliBin);
      assertion((metadata.mode & 0o111) !== 0, "installed CLI is executable");
      assertion(await pathExists(join(state.consumer, "node_modules", "gradient.md", "src", "skill", "SKILL.md")), "installed package exposes its skill source");
    });

    await scenario("fixtures", "Create an isolated project, home, histories, and local backends", "isolation", async ({ assertion, equal }) => {
      await Promise.all([
        mkdir(state.home, { recursive: true }),
        mkdir(state.project, { recursive: true }),
        mkdir(state.fakeBin, { recursive: true }),
      ]);
      const gitInit = await command("git init --quiet <project>", "git", ["init", "--quiet", state.project], { cwd: state.sandbox, env: process.env });
      equal(gitInit.exitCode, 0, "synthetic project is a Git repository");

      const fakeBackend = `#!${process.execPath}\n` + String.raw`
import { basename } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const ids = [...input.matchAll(/"id"\s*:\s*"(c_[a-f0-9]+)"/g)].map(match => match[1]);
let result;
if (ids.length > 0) {
  const payload = /"kind"\s*:\s*"loop"/.test(input)
    ? { type: "loop" }
    : { type: "command", commandName: "dogfood-scan", mechanical: true };
  result = JSON.stringify({ suggestions: [{
    sourceIds: [ids[0]], name: "dogfood-scan", confidence: "high",
    payload
  }] });
} else if (input.includes("DOGFOOD_STAND_DOWN")) {
  result = JSON.stringify({ action: "stand_down", why: "deterministic dogfood stand-down" });
} else if (input.includes("DOGFOOD_CONTINUE")) {
  result = JSON.stringify({ action: "continue", response: "synthetic", why: "deterministic progress remains" });
} else {
  result = JSON.stringify({ action: "stand_down", why: "deterministic dogfood stand-down" });
}
process.stdout.write(basename(process.argv[1]) === "claude" ? JSON.stringify({ result }) : result);
`;
      for (const name of ["claude", "codex"]) {
        const path = join(state.fakeBin, name);
        await writeFile(path, fakeBackend, { mode: 0o755 });
        await chmod(path, 0o755);
      }

      const encoded = state.project.replace(/[\\/]/g, "-").replace(/:/g, "-");
      const claudeRoot = join(state.home, ".claude", "projects", encoded);
      const codexRoot = join(state.home, ".codex", "sessions", "2026", "07", "18");
      await Promise.all([mkdir(claudeRoot, { recursive: true }), mkdir(codexRoot, { recursive: true })]);
      const now = Date.now() - 60_000;
      const iso = offset => new Date(now + offset * 1000).toISOString();
      const claudeLine = (type, sessionId, timestamp, content) => JSON.stringify({
        type, sessionId, cwd: state.project, timestamp,
        message: { role: type === "assistant" ? "assistant" : "user", content },
      });
      const repeated = "format the dogfood report and run the focused tests";
      for (let session = 1; session <= 2; session += 1) {
        const sessionId = `claude-dogfood-${session}`;
        const lines = [
          claudeLine("user", sessionId, iso(session * 10), repeated),
          claudeLine("assistant", sessionId, iso(session * 10 + 1), [
            { type: "text", text: "Synthetic assistant output." },
            { type: "tool_use", name: "Edit", id: `tool-${session}` },
          ]),
          claudeLine("user", sessionId, iso(session * 10 + 2), repeated),
          claudeLine("user", sessionId, iso(session * 10 + 3), "<command-name>/compact</command-name>"),
          claudeLine("user", sessionId, iso(session * 10 + 4), session === 1 ? `unique redaction probe ${SECRET_SENTINEL}` : repeated),
        ];
        const path = join(claudeRoot, `session-${session}.jsonl`);
        await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
        if (session === 1) state.claudeTranscript = path;
      }

      for (let session = 1; session <= 2; session += 1) {
        const sessionId = `codex-dogfood-${session}`;
        const records = [
          { type: "session_meta", timestamp: iso(session * 20), payload: { id: sessionId, cwd: state.project, source: "cli", git: { branch: "main" } } },
          { type: "event_msg", timestamp: iso(session * 20 + 1), payload: { type: "user_message", message: repeated, images: [] } },
          { type: "event_msg", timestamp: iso(session * 20 + 2), payload: { type: "user_message", message: repeated, images: [] } },
          { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 120, cached_input_tokens: 20 } } } },
        ];
        await writeFile(join(codexRoot, `rollout-${session}.jsonl`), `${records.map(record => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
      }

      state.productEnv = {
        ...process.env,
        GRADIENT_HOME: state.home,
        NO_COLOR: "1",
        TERM: "dumb",
        PATH: `${state.fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      };
      delete state.productEnv.GRADIENT_AUTOPILOT_CHILD;
      assertion(state.home.startsWith(state.sandbox), "Gradient home is inside the disposable sandbox");
      assertion(state.project.startsWith(state.sandbox), "project is inside the disposable sandbox");
      assertion(state.claudeTranscript.startsWith(join(state.home, ".claude", "projects")), "transcripts are synthetic and isolated");
    }, ["package"]);

    await scenario("surface", "Verify installed and plugin distribution surfaces", "distribution", async ({ assertion, equal }) => {
      const version = await runCli(["--version"]);
      equal(version.exitCode, 0, "installed --version exits zero");
      equal(version.stdout.trim(), state.package.version, "installed version matches packed metadata");
      const help = await runCli(["help"]);
      equal(help.exitCode, 0, "installed help exits zero");
      const publicCommands = publicCommandsFromHelp(help.stdout);
      const uncovered = [...publicCommands].filter(name => !COVERED_COMMANDS.has(name)).sort();
      equal(uncovered, [], "every advertised command has an explicit dogfood scenario");
      assertion(["checkpoint", "recap", "respond"].every(name => COVERED_COMMANDS.has(name)), "non-advertised hook targets also have dogfood scenarios");
      const bare = await runCli([]);
      equal(bare.exitCode, 0, "bare non-interactive invocation exits zero");
      assertion(bare.stdout.includes("turn repeated Claude Code and Codex workflows"), "bare non-TTY invocation renders the product surface");

      assertion(await pathExists(state.pluginBin), "committed plugin binary exists");
      const pluginVersion = await runPlugin(["--version"]);
      equal(pluginVersion.exitCode, 0, "plugin --version exits zero");
      equal(pluginVersion.stdout.trim(), state.package.version, "plugin and npm artifact versions match");
      const pluginHelp = await runPlugin(["help"]);
      equal(pluginHelp.exitCode, 0, "plugin help exits zero");
      assertion(pluginHelp.stdout.includes("gradient review"), "plugin bundle exposes the same CLI help");
    }, ["fixtures"]);

    await scenario("init", "Initialize both assistants in the isolated home", "setup", async ({ assertion, equal }) => {
      const result = await runCli(["init", "--target", "both", "--no-scan"]);
      equal(result.exitCode, 0, "dual-target init succeeds");
      assertion(result.stdout.includes("backend: claude-cli"), "init discovers the deterministic Claude CLI backend");
      for (const path of [
        join(state.home, ".claude", "skills", "gradient", "SKILL.md"),
        join(state.home, ".agents", "skills", "gradient", "SKILL.md"),
      ]) {
        assertion(await pathExists(path), `init installs ${relative(state.home, path)}`);
        const metadata = await stat(path);
        equal(metadata.mode & 0o077, 0, `init skill ${relative(state.home, path)} is private`);
      }
      const config = await readJson(configPath);
      equal(config.targets, ["claude-code", "codex"], "init persists both assistant targets");
      equal(config.backend, "claude-cli", "init persists the selected private CLI backend");
      equal((await stat(configPath)).mode & 0o077, 0, "Gradient config is private");
    }, ["surface"]);

    await scenario("scan", "Mine synthetic Claude Code and Codex histories through both backends", "mining", async ({ assertion, equal }) => {
      const both = await runCli(["scan", "--no-review"]);
      equal(both.exitCode, 0, "project scan succeeds");
      assertion(both.stdout.includes("Claude Code") && both.stdout.includes("Codex"), "project scan reports both transcript sources");
      assertion(both.stdout.includes("dogfood-scan"), "Claude-backed classification emits a deterministic suggestion");
      let cached = await readJson(await suggestionsPath());
      assertion(cached.some(suggestion => suggestion.name === "dogfood-scan"), "scan persists its suggestion in the isolated cache");

      const user = await runCli(["scan", "--user", "--since", "30d", "--no-review"]);
      equal(user.exitCode, 0, "bounded cross-project scan succeeds");
      assertion(user.stdout.includes("user scope"), "cross-project scope is visible in output");

      await updateConfig({ targets: ["codex"], backend: "codex-cli" });
      const codex = await runCli(["scan", "--no-review"]);
      equal(codex.exitCode, 0, "Codex-only scan succeeds");
      assertion(codex.stdout.includes("sources: Claude Code 0 prompt(s) · Codex"), "Codex collector supplies the mined prompts");
      cached = await readJson(await suggestionsPath());
      assertion(cached.length > 0, "Codex CLI protocol produces validated suggestions");
      await updateConfig({ targets: ["claude-code", "codex"], backend: "claude-cli" });
    }, ["init"]);

    await scenario("review-read", "Inspect, explain, and surface a mined suggestion", "review", async ({ assertion, equal }) => {
      const review = await runCli(["review", "--json"]);
      equal(review.exitCode, 0, "review --json succeeds");
      const parsed = JSON.parse(review.stdout);
      assertion(Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0, "review JSON exposes pending suggestions");
      const suggestion = parsed.suggestions[0];
      const explain = await runCli(["explain", suggestion.name]);
      equal(explain.exitCode, 0, "explain succeeds for a cached suggestion");
      assertion(explain.stdout.includes("seen") && explain.stdout.includes(suggestion.name), "explain shows evidence and identity");
      const sessionStart = await runCli(["session-start"]);
      equal(sessionStart.exitCode, 0, "session-start hook target exits zero");
      assertion(sessionStart.stdout.includes("gradient review"), "session-start surfaces a high-leverage pending suggestion");
      const detachedComplete = await waitFor(async () => {
        const path = join(state.project, ".gradient", "last-scan.log");
        if (!(await pathExists(path))) return false;
        const text = await readFile(path, "utf8");
        return text.includes("Next:") || text.includes("no suggestions found");
      });
      assertion(detachedComplete, "session-start's detached rescan completes with a diagnostic log");
    }, ["scan"]);

    await scenario("migration", "Apply and migrate a legacy command artifact", "artifacts", async ({ assertion, equal }) => {
      await updateConfig({ targets: ["claude-code"], emitTarget: "command", backend: "claude-cli" });
      const legacy = baseSuggestion("dogfoodlegacy", "dogfood-legacy", {
        type: "command", commandName: "dogfood-legacy",
        body: "Review the synthetic evidence, then run the requested verification steps.",
        triggers: ["migrate the synthetic command"],
      });
      await seedSuggestions([legacy]);
      const applied = await runCli(["apply", legacy.name]);
      equal(applied.exitCode, 0, "legacy command apply succeeds");
      const commandPath = join(state.project, ".claude", "commands", `${legacy.name}.md`);
      assertion(await pathExists(commandPath), "legacy command is written through the installed CLI");
      const dry = await runCli(["migrate", "--dry-run"]);
      equal(dry.exitCode, 0, "migration dry run succeeds");
      assertion(dry.stdout.includes("would migrate"), "migration dry run names the candidate");
      const migrated = await runCli(["migrate"]);
      equal(migrated.exitCode, 0, "command migration succeeds");
      assertion(!(await pathExists(commandPath)), "migration removes the owned legacy command");
      assertion(await pathExists(join(state.project, ".claude", "skills", legacy.name, "SKILL.md")), "migration writes a model-invokable skill");
    }, ["review-read"]);

    await scenario("artifact-matrix", "Apply every generated artifact family and inspect ownership", "artifacts", async ({ assertion, equal }) => {
      await updateConfig({ targets: ["claude-code", "codex"], emitTarget: "skill", backend: "claude-cli" });
      const suggestions = [
        baseSuggestion("dogfoodskill", "dogfood-skill", {
          type: "command", commandName: "dogfood-skill", mechanical: true,
          body: "Prepare a deterministic release report and run the focused checks requested now.",
          triggers: ["prepare a deterministic release report"],
        }),
        baseSuggestion("dogfoodrule", "dogfood-rule", {
          type: "rule", target: "project", ruleName: "dogfood-rule",
          text: "Use deterministic synthetic fixtures for low-impact dogfood checks; ask before consequential actions.",
        }),
        baseSuggestion("dogfooduserrule", "dogfood-user-rule", {
          type: "rule", target: "user", ruleName: "dogfood-user-rule",
          text: "Prefer concise dogfood evidence summaries for low-impact reporting.",
        }),
        baseSuggestion("dogfoodloop", "dogfood-loop", {
          type: "loop", instruction: "Review the synthetic dogfood report.", cadence: "0 9 * * 1-5",
        }),
        baseSuggestion("dogfoodcompact", "dogfood-compact", {
          type: "hook", event: "PreCompact", subcommand: "checkpoint",
          description: "Save a synthetic checkpoint before compaction.",
        }),
        baseSuggestion("dogfoodsession", "dogfood-session", {
          type: "hook", event: "SessionStart", subcommand: "session-start",
          description: "Surface a suggestion and rescan at session start.",
        }),
        baseSuggestion("dogfoodnotify", "dogfood-notify", {
          type: "hook", event: "Notification", matcher: "permission_prompt|idle_prompt", subcommand: "notify",
          description: "Notify when the assistant needs input.",
        }),
        baseSuggestion("dogfoodpostedit", "dogfood-post-edit", {
          type: "hook", event: "PostToolUse", matcher: "Edit|Write|NotebookEdit", command: "npm run lint",
          description: "Run the reviewed lint command after edits.",
        }),
        baseSuggestion("dogfoodplaybook", "dogfood-playbook", {
          type: "project-playbook", section: "workflows",
          text: "After changing release evidence, run the packaged dogfood gate.",
        }),
        baseSuggestion("dogfoodtamper", "dogfood-tamper", {
          type: "command", commandName: "dogfood-tamper",
          body: "Synthetic artifact reserved for provenance refusal testing.",
          triggers: ["test provenance refusal"],
        }),
      ];
      await seedSuggestions(suggestions);
      const applied = await runCli(["apply", ...suggestions.map(suggestion => suggestion.name)]);
      equal(applied.exitCode, 0, "full artifact matrix applies through the installed CLI");
      assertion(applied.stdout.includes("skipped codex"), "non-portable artifact types are explicitly skipped for Codex");

      for (const path of [
        join(state.project, ".claude", "skills", "dogfood-skill", "SKILL.md"),
        join(state.project, ".agents", "skills", "dogfood-skill", "SKILL.md"),
        join(state.project, ".claude", "rules", "gradient-dogfood-rule.md"),
      ]) {
        assertion(await pathExists(path), `${relative(state.project, path)} exists`);
        equal((await stat(path)).mode & 0o077, 0, `${relative(state.project, path)} is private`);
        assertion((await readFile(path, "utf8")).includes("gradient:generated"), `${relative(state.project, path)} has provenance`);
      }
      const playbook = await readFile(join(state.project, "gradient.md"), "utf8");
      assertion(playbook.includes("<!-- gradient:dogfoodplaybook -->"), "project playbook entry is tagged line-surgically");
      const settings = await readJson(join(state.project, ".claude", "settings.local.json"));
      for (const event of ["PreCompact", "SessionStart", "Notification", "PostToolUse"]) {
        assertion(Array.isArray(settings.hooks[event]), `${event} hook is installed by approval`);
      }
      const list = await runCli(["list"]);
      equal(list.exitCode, 0, "artifact list succeeds");
      for (const name of ["dogfood-skill", "dogfood-rule", "dogfood-loop", "dogfood-playbook"]) {
        assertion(list.stdout.includes(name), `artifact list includes ${name}`);
      }

      const tamperPath = join(state.project, ".claude", "skills", "dogfood-tamper", "SKILL.md");
      await writeFile(tamperPath, "hand-edited content without provenance\n", { mode: 0o600 });
      const refused = await runCli(["remove", "dogfood-tamper"]);
      equal(refused.exitCode, 1, "tampered artifact removal is refused");
      assertion(await pathExists(tamperPath), "tampered artifact remains untouched after refusal");
    }, ["migration"]);

    await scenario("bundle", "Build a portable team plugin and reject hook export", "portability", async ({ assertion, equal }) => {
      const result = await runCli(["bundle", "dogfood-team"]);
      equal(result.exitCode, 0, "team bundle succeeds");
      const root = join(state.project, ".gradient", "bundle", "dogfood-team");
      const claudePlugin = await readJson(join(root, ".claude-plugin", "plugin.json"));
      const codexPlugin = await readJson(join(root, ".codex-plugin", "plugin.json"));
      equal(claudePlugin.version, state.package.version, "Claude plugin metadata uses the package version");
      equal(codexPlugin.version, state.package.version, "Codex plugin metadata uses the package version");
      assertion(await pathExists(join(root, "skills", "dogfood-skill", "SKILL.md")), "portable skill is included once");
      assertion(!(await pathExists(join(root, ".claude", "settings.local.json"))), "hook settings are not exported");
      assertion(result.stdout.includes("skipped dogfood-loop") || result.stdout.includes("dogfood-loop"), "non-portable loop is reported as skipped");
      const disabled = await runCli(["bundle", "unsafe", "--with-hooks"]);
      equal(disabled.exitCode, 2, "hook bundle request is rejected as a usage error");
      assertion(disabled.stdout.includes("hooks are disabled"), "hook-export refusal explains the consent boundary");
    }, ["artifact-matrix"]);

    await scenario("recall", "Enable recall, observe a hit, and record adoption", "runtime", async ({ assertion, equal }) => {
      const on = await runCli(["recall", "on"]);
      equal(on.exitCode, 0, "recall enable succeeds");
      const statusResult = await runCli(["recall", "status"]);
      equal(statusResult.exitCode, 0, "recall status succeeds");
      assertion(statusResult.stdout.includes("recall: on"), "recall status reports local consent");
      const hook = await runCli(["recall"], {
        input: JSON.stringify({
          prompt: "prepare a deterministic release report",
          cwd: state.project,
          session_id: "dogfood-recall-session",
        }),
      });
      equal(hook.exitCode, 0, "recall hook exits zero");
      const payload = JSON.parse(hook.stdout);
      equal(payload.hookSpecificOutput.hookEventName, "UserPromptSubmit", "recall returns the structured hook contract");
      assertion(payload.hookSpecificOutput.additionalContext.includes("dogfood-skill"), "recall names the matching installed skill");
      const adoption = await readFile(join(await projectCacheDir(), "recall.adoption.jsonl"), "utf8");
      assertion(adoption.includes("dogfood-skill") && !adoption.includes("prepare a deterministic"), "adoption log stores metadata, not prompt text");
    }, ["bundle"]);

    await scenario("interactive-review", "Approve a suggestion and re-pin a changed project playbook", "review", async ({ assertion, equal }) => {
      const suggestion = baseSuggestion("dogfoodreviewed", "dogfood-reviewed", {
        type: "command", commandName: "dogfood-reviewed",
        body: "Approved through the installed interactive review surface.",
        triggers: ["approve the interactive dogfood fixture"],
      });
      await seedSuggestions([suggestion]);
      const review = await runCli(["review"], { input: "a\n" });
      equal(review.exitCode, 0, "interactive review approval succeeds");
      assertion(review.stdout.includes("applied 1 suggestion"), "interactive review reports one applied suggestion");
      assertion(await pathExists(join(state.project, ".claude", "skills", suggestion.name, "SKILL.md")), "interactive approval writes the artifact");

      const playbookPath = join(state.project, "gradient.md");
      await writeFile(playbookPath, `${await readFile(playbookPath, "utf8")}\n- Manually reviewed dogfood note.\n`, { mode: 0o644 });
      await seedSuggestions([]);
      const pin = await runCli(["review"], { input: "a\n" });
      equal(pin.exitCode, 0, "project playbook approval succeeds");
      const pinState = await readJson(join(await projectCacheDir(), "playbook-pin.json"));
      assertion(pinState.prose.includes("Manually reviewed dogfood note"), "review pins the exact changed project prose");
    }, ["recall"]);

    await scenario("insights", "Render stats and terminal/HTML insights from composed state", "reporting", async ({ assertion, equal }) => {
      const statsResult = await runCli(["stats"]);
      equal(statsResult.exitCode, 0, "stats succeeds");
      assertion(statsResult.stdout.includes("coverage:") && statsResult.stdout.includes("adoption:"), "stats composes coverage and adoption evidence");
      const insights = await runCli(["insights", "--html"]);
      equal(insights.exitCode, 0, "insights HTML succeeds");
      assertion(insights.stdout.includes("prompts") && insights.stdout.includes("wrote"), "terminal insights summarize behavior and report the HTML path");
      const htmlPath = join(state.project, ".gradient", "insights.html");
      assertion(await pathExists(htmlPath), "self-contained insights HTML is written");
      assertion((await readFile(htmlPath, "utf8")).includes("<!doctype html>"), "insights artifact is HTML");
    }, ["interactive-review"]);

    await scenario("continuity", "Round-trip continuity hooks, checkpoint, and recap", "runtime", async ({ assertion, equal }) => {
      const on = await runCli(["continuity", "on"]);
      equal(on.exitCode, 0, "continuity enable succeeds");
      const statusOn = await runCli(["continuity", "status"]);
      assertion(statusOn.stdout.includes("PreCompact): on") && statusOn.stdout.includes("SessionStart): on"), "continuity status reports both hooks on");
      const checkpoint = await runCli(["checkpoint"], { input: JSON.stringify({ transcript_path: state.claudeTranscript }) });
      equal(checkpoint.exitCode, 0, "checkpoint hook exits zero");
      equal(checkpoint.stdout, "", "checkpoint hook keeps stdout empty");
      const recap = await runCli(["recap"]);
      equal(recap.exitCode, 0, "recap succeeds");
      assertion(recap.stdout.includes("gradient-continuity-note") && recap.stdout.includes("Progress checkpoint"), "recap returns bounded untrusted checkpoint context");
      assertion(!recap.stdout.includes(SECRET_SENTINEL), "checkpoint/recap redacts the secret sentinel");
      const off = await runCli(["continuity", "off"]);
      equal(off.exitCode, 0, "continuity disable succeeds");
      const statusOff = await runCli(["continuity", "status"]);
      assertion(statusOff.stdout.includes("PreCompact): off") && statusOff.stdout.includes("SessionStart): off"), "continuity status reports both hooks off");
    }, ["insights"]);

    await scenario("autopilot", "Exercise autopilot continue, progress, stand-down, and consent removal", "runtime", async ({ assertion, equal }) => {
      await updateConfig({ backend: "claude-cli", targets: ["claude-code", "codex"] });
      const on = await runCli(["autopilot", "nudge"]);
      equal(on.exitCode, 0, "autopilot nudge enable succeeds");
      const statusOn = await runCli(["autopilot", "status"]);
      assertion(statusOn.stdout.includes("mode: nudge") && statusOn.stdout.includes("project gradient.md pin: pinned"), "autopilot status reports mode and reviewed project context");

      const transcript = state.claudeTranscript;
      await writeFile(transcript, `${await readFile(transcript, "utf8")}\n${JSON.stringify({
        type: "user", sessionId: "autopilot", cwd: state.project,
        message: { role: "user", content: "DOGFOOD_CONTINUE: continue the synthetic check" },
      })}\n${JSON.stringify({
        type: "assistant", sessionId: "autopilot",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] },
      })}\n`, { mode: 0o600 });
      const input = { session_id: "dogfood-autopilot", transcript_path: transcript, cwd: state.project, hook_event_name: "Stop" };
      const continued = await runCli(["respond"], { input: JSON.stringify(input) });
      equal(continued.exitCode, 0, "respond hook exits zero on continue");
      const decision = JSON.parse(continued.stdout);
      equal(decision, { decision: "block", reason: "Continue." }, "autopilot emits only the bounded safe nudge");

      await writeFile(transcript, `${await readFile(transcript, "utf8")}${JSON.stringify({
        type: "user", sessionId: "autopilot", cwd: state.project,
        message: { role: "user", content: "DOGFOOD_STAND_DOWN" },
      })}\n${JSON.stringify({
        type: "assistant", sessionId: "autopilot",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] },
      })}\n`, { mode: 0o600 });
      const stoodDown = await runCli(["respond"], { input: JSON.stringify(input) });
      equal(stoodDown.exitCode, 0, "respond hook exits zero on stand-down");
      equal(stoodDown.stdout, "", "stand-down keeps hook stdout empty");
      const statusAfter = await runCli(["autopilot", "status"]);
      assertion(statusAfter.stdout.includes("deterministic dogfood stand-down"), "autopilot status records the deterministic judge decision");
      const off = await runCli(["autopilot", "off"]);
      equal(off.exitCode, 0, "autopilot disable succeeds");
      const statusOff = await runCli(["autopilot", "status"]);
      assertion(statusOff.stdout.includes("mode: off") && statusOff.stdout.includes("stop hook here: not installed"), "autopilot consent and hook are removed together");
    }, ["continuity"]);

    await scenario("hook-contracts", "Verify notification and malformed hook inputs fail open", "runtime", async ({ assertion, equal }) => {
      const notify = await runCli(["notify"], { input: JSON.stringify({ hook_event_name: "Notification" }) });
      equal(notify.exitCode, 0, "notification hook exits zero without desktop support");
      equal(notify.stdout, "", "notification hook is silent");
      for (const name of ["recall", "checkpoint", "respond"]) {
        const result = await runCli([name], { input: "{malformed" });
        equal(result.exitCode, 0, `${name} malformed hook input fails open`);
        equal(result.stdout, "", `${name} malformed hook input stays silent`);
      }
    }, ["fixtures"]);

    await scenario("security", "Refuse corrupt, oversized, symlinked, and unknown inputs", "safety", async ({ assertion, equal }) => {
      const unknown = await runCli(["definitely-not-a-command"]);
      equal(unknown.exitCode, 2, "unknown command is a usage error");
      assertion(unknown.stdout.includes("unknown command"), "unknown command prints safe guidance");

      const savedConfig = await readFile(configPath, "utf8");
      await writeFile(configPath, "{broken", { mode: 0o600 });
      const corruptConfig = await runCli(["stats"]);
      equal(corruptConfig.exitCode, 1, "corrupt config fails closed");
      assertion(corruptConfig.stdout.includes("refusing unreadable gradient config"), "corrupt config refusal is explicit");
      await writeFile(configPath, savedConfig, { mode: 0o600 });

      const cachePath = await suggestionsPath();
      await writeFile(cachePath, "{broken", { mode: 0o600 });
      const corruptCache = await runCli(["review", "--json"]);
      equal(corruptCache.exitCode, 0, "corrupt suggestion cache degrades safely");
      equal(JSON.parse(corruptCache.stdout).suggestions, [], "corrupt cache exposes no suggestions");

      await writeFile(cachePath, `[${" ".repeat(5_000_100)}]`, { mode: 0o600 });
      const oversized = await runCli(["review", "--json"]);
      equal(oversized.exitCode, 0, "oversized suggestion cache degrades safely");
      equal(JSON.parse(oversized.stdout).suggestions, [], "oversized cache exposes no suggestions");

      const outside = join(state.sandbox, "outside-suggestions.json");
      await writeJson(outside, [baseSuggestion("symlinkescape", "symlink-escape", {
        type: "command", commandName: "symlink-escape", body: "must never load", triggers: ["never load"],
      })]);
      await rm(cachePath, { force: true });
      await symlink(outside, cachePath);
      const linked = await runCli(["review", "--json"]);
      equal(linked.exitCode, 0, "symlinked suggestion cache is refused without crashing");
      equal(JSON.parse(linked.stdout).suggestions, [], "symlink target content is not loaded");
      await rm(cachePath, { force: true });
      await seedSuggestions([]);
    }, ["init", "hook-contracts"]);

    await scenario("cleanup", "Remove owned artifacts and feature consent without collateral changes", "lifecycle", async ({ assertion, equal }) => {
      const before = await readJson(join(state.project, ".claude", "settings.local.json"));
      const removedHook = await runCli(["remove", "dogfood-notify"]);
      equal(removedHook.exitCode, 0, "owned hook removal succeeds");
      const after = await readJson(join(state.project, ".claude", "settings.local.json"));
      assertion(!JSON.stringify(after).includes("gradient notify"), "owned notification hook is removed");
      assertion(JSON.stringify(after).includes("npm run lint") === JSON.stringify(before).includes("npm run lint"), "adjacent reviewed command hook is preserved");

      const removedPlaybook = await runCli(["remove", "dogfood-playbook"]);
      equal(removedPlaybook.exitCode, 0, "tagged project-playbook removal succeeds");
      const playbook = await readFile(join(state.project, "gradient.md"), "utf8");
      assertion(!playbook.includes("<!-- gradient:dogfoodplaybook -->"), "only the owned tagged line is removed");
      assertion(playbook.includes("Manually reviewed dogfood note"), "manual playbook prose survives removal");

      const recallOff = await runCli(["recall", "off"]);
      equal(recallOff.exitCode, 0, "recall disable succeeds");
      const recallStatus = await runCli(["recall", "status"]);
      assertion(recallStatus.stdout.includes("recall: off"), "recall status reports consent removed");
    }, ["artifact-matrix", "interactive-review", "security"]);

    await scenario("evidence", "Validate evidence hygiene and private state modes", "evidence", async ({ assertion, equal }) => {
      const approvalPath = join(await projectCacheDir(), "artifact-approvals.json");
      assertion(await pathExists(approvalPath), "private artifact approval ledger exists");
      const privatePaths = [
        configPath,
        await suggestionsPath(),
        approvalPath,
        join(await projectCacheDir(), "playbook-pin.json"),
        join(await projectCacheDir(), "recall.json"),
        join(await projectCacheDir(), "recall.adoption.jsonl"),
        join(state.home, ".config", "gradient", "state", "dogfood-autopilot.json"),
      ];
      for (const path of privatePaths) {
        assertion(await pathExists(path), `${relative(state.home, path)} exists`);
        equal((await stat(path)).mode & 0o077, 0, `${relative(state.home, path)} is private`);
      }
      const preview = JSON.stringify(state.cases);
      assertion(!preview.includes(SECRET_SENTINEL), "recorded command evidence contains no secret sentinel");
      assertion(!preview.includes(state.home) && !preview.includes(state.sandbox), "recorded evidence contains no temporary absolute paths");
    }, ["cleanup", "autopilot"]);
  } finally {
    const report = {
      schemaVersion: 1,
      result: state.cases.some(item => item.status === "failed") ? "fail" : "pass",
      generatedAt: new Date().toISOString(),
      proof: "synthetic-packaged",
      package: {
        name: state.package.name,
        version: state.package.version,
        tarballSha256: state.package.tarballSha256,
      },
      source: { commit: state.sourceCommit },
      runtime: {
        node: process.version,
        platform: platform(),
        release: release(),
        arch: process.arch,
      },
      sandboxKept: options.keep,
      limitations: LIVE_LIMITATIONS,
      totals: totals(state.cases),
      cases: state.cases,
    };
    await mkdir(options.output, { recursive: true });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = renderMarkdown(report);
    const html = renderHtml(report);
    if ([json, markdown, html].some(value => value.includes(SECRET_SENTINEL))) {
      report.result = "fail";
      process.stderr.write("dogfood evidence contained the secret sentinel; refusing to write reports\n");
      process.exitCode = 1;
    } else {
      await Promise.all([
        writeFile(join(options.output, "report.json"), json, { mode: 0o600 }),
        writeFile(join(options.output, "report.md"), markdown, { mode: 0o600 }),
        writeFile(join(options.output, "report.html"), html, { mode: 0o600 }),
      ]);
      const count = report.totals;
      process.stdout.write(
        `dogfood ${report.result}: ${count.passed} passed, ${count.failed} failed, ${count.skipped} skipped\n` +
        `evidence: ${join(options.output, "report.html")}\n`,
      );
      process.exitCode = report.result === "pass" ? 0 : 1;
    }
    if (options.keep) {
      process.stdout.write(`synthetic sandbox kept: ${sandbox}\n`);
    } else {
      await rm(sandbox, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  process.stderr.write(`dogfood: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
