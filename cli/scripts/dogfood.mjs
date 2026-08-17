#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
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
import { SKILLS, codexName, forCodex } from "./skill-render.mjs";

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
  // The four advertised verbs, plus the hidden hook targets the gate drives.
  // Nothing else: this release deletes its aliases rather than keeping them.
  "<bare>", "help", "optimize", "remove", "on", "off",
  "hook", "session-start", "notify", "recap", "checkpoint", "respond",
]);


/** Hook commands are written in whichever binary form resolves here: a bare
 *  `gradient` when it is on PATH, `<node> <script>` otherwise. CI has no global
 *  install, so assert on the subcommand a hook runs rather than on one spelling
 *  of the binary that happens to be true on a developer's machine. */
function installedHookCommands(settings, event) {
  return (settings?.hooks?.[event] ?? []).flatMap(entry => (entry.hooks ?? []).map(hook => hook.command ?? ""));
}

function runsSubcommand(settings, event, subcommand) {
  return installedHookCommands(settings, event).some(command => command.trim().endsWith(` ${subcommand}`));
}

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

async function lockedProductionDependencies() {
  const lock = await readJson(join(cliDir, "package-lock.json"));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock.json must use lockfileVersion 3 with a packages map");
  }
  const nodeModulesRoot = resolve(cliDir, "node_modules");
  const dependencies = [];
  for (const [lockPath, metadata] of Object.entries(lock.packages)) {
    if (!lockPath.startsWith("node_modules/") || metadata?.dev === true) continue;
    const sourcePath = resolve(cliDir, lockPath);
    if (!sourcePath.startsWith(`${nodeModulesRoot}/`)) {
      throw new Error(`locked production dependency escapes node_modules: ${lockPath}`);
    }
    const sourceMetadata = await lstat(sourcePath);
    if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
      throw new Error(`locked production dependency is not an installed directory: ${lockPath}`);
    }
    dependencies.push({ lockPath, sourcePath });
  }
  return dependencies.sort((left, right) => left.lockPath.localeCompare(right.lockPath));
}

async function stageProductionDependencies(dependencies, seedRoot) {
  const staged = [];
  for (const dependency of dependencies) {
    const installPath = join(seedRoot, dependency.lockPath);
    await mkdir(dirname(installPath), { recursive: true });
    await cp(dependency.sourcePath, installPath, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    });
    const manifestPath = join(installPath, "package.json");
    const manifest = await readJson(manifestPath);
    delete manifest.scripts;
    delete manifest.packageManager;
    await writeJson(manifestPath, manifest, 0o644);
    staged.push({ ...dependency, installPath });
  }
  return staged;
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
    home: join(sandbox, "gradient-home"),
    project: join(sandbox, "project"),
    fakeBin: join(sandbox, "fake-bin"),
    // Where Claude Code puts a plugin it has installed from a marketplace.
    pluginRoot: join(sandbox, "gradient-home", ".claude", "plugins", "cache", "gradient", "gradient"),
    cliBin: "",
    pluginBin: "",
    package: { name: "gradient", version: "unknown", tarballSha256: "unknown" },
    sourceCommit: "unknown",
    productEnv: undefined,
    claudeTranscript: "",
    cases: [],
  };
  const status = new Map();
  let activeCase;
  const replacements = () => [
    [state.home, "<gradient-home>"],
    [state.project, "<project>"],
    [state.pluginRoot, "<plugin-root>"],
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
    await scenario("artifacts", "Verify the committed release artifacts", "distribution", async ({ assertion, equal }) => {
      const git = await command("git rev-parse HEAD", "git", ["rev-parse", "HEAD"], { cwd: repoRoot, env: process.env });
      if (git.exitCode === 0) state.sourceCommit = git.stdout.trim();
      state.package.version = JSON.parse(await readFile(join(cliDir, "package.json"), "utf8")).version;

      // gradient ships as files in the repository, not as a package: the plugin
      // Claude Code clones, and the three skill directories a Codex user copies.
      // Every one of them carries the same runner, so a mismatch here means one
      // install shape is running a different gradient than the others.
      const pluginBundle = await readFile(join(repoRoot, "plugin", "bin", "gradient.mjs"));
      state.package.tarballSha256 = sha256(pluginBundle);
      for (const name of SKILLS) {
        const dir = join(repoRoot, "skills", codexName(name));
        assertion(pluginBundle.equals(await readFile(join(dir, "bin", "gradient.mjs"))),
          `skills/${codexName(name)} carries the same runner as the plugin`);
        equal(await readFile(join(dir, "SKILL.md"), "utf8"),
          forCodex(await readFile(join(repoRoot, "plugin", "skills", name, "SKILL.md"), "utf8"), name),
          `skills/${codexName(name)}/SKILL.md is what re-deriving from the plugin source produces`);
      }
    });

    await scenario("fixtures", "Create an isolated project, home, histories, and local backends", "isolation", async ({ assertion, equal }) => {
      await Promise.all([
        mkdir(state.home, { recursive: true }),
        mkdir(state.project, { recursive: true }),
        mkdir(state.fakeBin, { recursive: true }),
      ]);
      const gitInit = await command(
        "git init --quiet --initial-branch=main <project>",
        "git",
        ["init", "--quiet", "--initial-branch=main", state.project],
        { cwd: state.sandbox, env: process.env },
      );
      equal(gitInit.exitCode, 0, "synthetic project is a Git repository");
      await writeFile(join(state.project, "README.md"), "# Synthetic Gradient dogfood project\n", { mode: 0o644 });
      const gitAdd = await command("git add README.md", "git", ["add", "README.md"], { cwd: state.project, env: process.env });
      equal(gitAdd.exitCode, 0, "synthetic baseline is staged");
      const gitCommit = await command("git commit --quiet -m 'synthetic baseline'", "git", ["commit", "--quiet", "-m", "synthetic baseline"], {
        cwd: state.project,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Gradient Dogfood",
          GIT_AUTHOR_EMAIL: "dogfood@example.invalid",
          GIT_COMMITTER_NAME: "Gradient Dogfood",
          GIT_COMMITTER_EMAIL: "dogfood@example.invalid",
        },
      });
      equal(gitCommit.exitCode, 0, "synthetic main branch has a baseline commit");

      const fakeBackend = `#!${process.execPath}\n` + String.raw`
import { basename } from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
// Classify per candidate, not per request. Deciding one payload type from the
// whole prompt gave a paste candidate a loop payload, which detect rejects as
// an incompatible kind — the request looked answered and produced nothing.
// The two backends wrap the candidate array differently, and the Codex prompt
// embeds the system text — whose own JSON example contains brackets — so slice
// each candidate out by its opaque id rather than parsing the whole payload.
const candidates = input.split(/"id"\s*:\s*"/).slice(1).map(chunk => {
  const id = /^(c_[a-f0-9]+)"/.exec(chunk);
  if (!id) return null;
  const head = chunk.slice(0, Math.max(0, chunk.indexOf('"signature"')) || 200);
  const kind = /"kind"\s*:\s*"([a-z-]+)"/.exec(head);
  return { id: id[1], kind: kind ? kind[1] : "unknown" };
}).filter(Boolean);
let result;
if (candidates.length > 0) {
  const nameFor = (candidate, index) => candidate.kind === "loop"
    ? "dogfood-loop-echo"
    : candidate.kind === "paste" ? "dogfood-scan" : "dogfood-other" + index;
  result = JSON.stringify({ suggestions: candidates.map((candidate, index) => ({
    sourceIds: [candidate.id],
    name: nameFor(candidate, index),
    confidence: "high",
    payload: candidate.kind === "loop"
      ? { type: "loop" }
      : { type: "command", commandName: nameFor(candidate, index), mechanical: true },
  })) });
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
      // The real node, under a name the filter above cannot remove.
      const nodeShim = join(state.fakeBin, "node");
      if (!existsSync(nodeShim)) await symlink(process.execPath, nodeShim);

      const fakeGhPath = join(state.fakeBin, "gh");
      await writeFile(fakeGhPath, `#!${process.execPath}\nprocess.stdout.write("[]");\n`, { mode: 0o755 });
      await chmod(fakeGhPath, 0o755);

      const encoded = state.project.replace(/[\\/]/g, "-").replace(/:/g, "-");
      const claudeRoot = join(state.home, ".claude", "projects", encoded);
      const codexRoot = join(state.home, ".codex", "sessions", "2026", "07", "18");
      await Promise.all([mkdir(claudeRoot, { recursive: true }), mkdir(codexRoot, { recursive: true })]);
      const now = Date.now() - 60_000;
      const iso = offset => new Date(now + offset * 1000).toISOString();
      // One session per day. A habit is something that recurs on separate
      // occasions; a fixture whose sessions all land in the same minute is a
      // single sitting, and the recurrence gate correctly holds it back.
      const DAY_SECONDS = 86_400;
      const dayOf = session => -(3 - session) * DAY_SECONDS;
      const claudeLine = (type, sessionId, timestamp, content) => JSON.stringify({
        type, sessionId, cwd: state.project, timestamp,
        message: { role: type === "assistant" ? "assistant" : "user", content },
      });
      const repeated = "format the dogfood report and run the focused tests";
      // A repeated error paste. A plain repeated instruction can no longer
      // reach an artifact: detect rebuilds a command body from the prompt it
      // was mined from, so the result would be the prompt with a heading above
      // it and is dropped as a restatement. A paste's artifact is an advisory
      // diagnosis the user never typed, which is the point of generating it.
      const pastedError = `pnpm test\nError: Cannot find module '@dogfood/pkg'\n${"  at Module._resolveFilename (node:internal/modules/cjs/loader)\n".repeat(12)}`;
      for (let session = 1; session <= 2; session += 1) {
        const sessionId = `claude-dogfood-${session}`;
        const lines = [
          claudeLine("user", sessionId, iso(dayOf(session)), repeated),
          claudeLine("assistant", sessionId, iso(dayOf(session) + 1), [
            { type: "text", text: "Synthetic assistant output." },
            { type: "tool_use", name: "Edit", id: `tool-${session}`, input: { file_path: join(state.project, "README.md") } },
          ]),
          claudeLine("user", sessionId, iso(dayOf(session) + 2), repeated),
          claudeLine("user", sessionId, iso(dayOf(session) + 3), "<command-name>/compact</command-name>"),
          claudeLine("user", sessionId, iso(dayOf(session) + 4), session === 1 ? `unique redaction probe ${SECRET_SENTINEL}` : repeated),
          claudeLine("user", sessionId, iso(dayOf(session) + 5), pastedError),
          claudeLine("user", sessionId, iso(dayOf(session) + 6), pastedError),
        ];
        const path = join(claudeRoot, `session-${session}.jsonl`);
        await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600 });
        if (session === 1) state.claudeTranscript = path;
      }

      for (let session = 1; session <= 2; session += 1) {
        const sessionId = `codex-dogfood-${session}`;
        const records = [
          { type: "session_meta", timestamp: iso(dayOf(session) + 3_600), payload: { id: sessionId, cwd: state.project, source: "cli", git: { branch: "main" } } },
          { type: "event_msg", timestamp: iso(dayOf(session) + 3_601), payload: { type: "user_message", message: repeated, images: [] } },
          { type: "event_msg", timestamp: iso(dayOf(session) + 3_602), payload: { type: "user_message", message: repeated, images: [] } },
          { type: "event_msg", timestamp: iso(dayOf(session) + 3_603), payload: { type: "user_message", message: pastedError, images: [] } },
          { type: "event_msg", timestamp: iso(dayOf(session) + 3_604), payload: { type: "user_message", message: pastedError, images: [] } },
          { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 120, cached_input_tokens: 20 } } } },
        ];
        await writeFile(join(codexRoot, `rollout-${session}.jsonl`), `${records.map(record => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
      }

      state.productEnv = {
        ...process.env,
        GRADIENT_HOME: state.home,
        NO_COLOR: "1",
        TERM: "dumb",
        // Hide any globally installed gradient. The hook installer writes
        // whichever binary form resolves, so a developer machine with a global
        // install exercises a different code path from CI and from an npx user
        // — and the difference only showed up as a CI-only failure.
        //
        // Dropping the whole directory also drops everything else in it, and a
        // global `gradient` lives in the same bin directory as `node` on both
        // Homebrew and every version manager. `node` is shimmed into fake-bin
        // below so an installed skill's `node <runner>` still resolves — the
        // point is to hide gradient, not to build a PATH no real machine has.
        PATH: `${state.fakeBin}${delimiter}${(process.env.PATH ?? "").split(delimiter)
          .filter(dir => dir && !existsSync(join(dir, "gradient")))
          .join(delimiter)}`,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
      };
      delete state.productEnv.GRADIENT_AUTOPILOT_CHILD;
      assertion(state.home.startsWith(state.sandbox), "Gradient home is inside the disposable sandbox");
      assertion(state.project.startsWith(state.sandbox), "project is inside the disposable sandbox");
      assertion(state.claudeTranscript.startsWith(join(state.home, ".claude", "projects")), "transcripts are synthetic and isolated");
    }, ["artifacts"]);

    await scenario("install", "Install both shapes into an empty home, by copying", "distribution", async ({ assertion, equal }) => {
      // Exactly what the README tells a user to do, and nothing else: no
      // package manager, no PATH entry, no installer to fix anything up
      // afterwards. What is committed is what runs.
      // Where `$skill-installer` puts them — the installer the official
      // openai/skills catalog documents.
      for (const name of SKILLS) {
        await cp(join(repoRoot, "skills", codexName(name)),
          join(state.home, ".codex", "skills", codexName(name)), { recursive: true });
      }
      await cp(join(repoRoot, "plugin"), state.pluginRoot, { recursive: true });

      state.cliBin = join(state.home, ".codex", "skills", "gradient-optimize", "bin", "gradient.mjs");
      state.pluginBin = join(state.pluginRoot, "bin", "gradient.mjs");
      for (const [label, path] of [["skill", state.cliBin], ["plugin", state.pluginBin]]) {
        assertion(await pathExists(path), `the copied ${label} carries its runner`);
        const version = await command(`node <${label}-runner> --version`, process.execPath, [path, "--version"],
          { cwd: state.project, env: state.productEnv });
        equal(version.exitCode, 0, `the copied ${label} runner starts`);
        equal(version.stdout.trim(), state.package.version, `the copied ${label} runner is this version`);
      }
    }, ["artifacts", "fixtures"]);

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
      // A bare invocation is the report, in a pipe as much as in a terminal.
      // It used to print help outside a TTY, which meant the one command that
      // is the product was the one an agent or a pipe never saw.
      assertion(
        bare.stdout.includes("prompts ") && bare.stdout.includes("features:") && !bare.stdout.includes("Usage:"),
        "bare non-TTY invocation renders the report, not help",
      );

      assertion(await pathExists(state.pluginBin), "installed plugin binary exists");
      const pluginVersion = await runPlugin(["--version"]);
      equal(pluginVersion.exitCode, 0, "plugin --version exits zero");
      equal(pluginVersion.stdout.trim(), state.package.version, "plugin and skill artifact versions match");
      const pluginHelp = await runPlugin(["help"]);
      equal(pluginHelp.exitCode, 0, "plugin help exits zero");
      assertion(pluginHelp.stdout.includes("gradient on|off <feature>"), "plugin bundle exposes the same CLI help");
      // The two shapes are one build; a user who installs both must not get two gradients.
      equal(sha256(await readFile(state.cliBin)), sha256(await readFile(state.pluginBin)),
        "the installed skill runner and the installed plugin runner are the same build");
      // Every verb this release deleted must read as unknown, not as a typo.
      for (const gone of ["scan", "review", "apply", "init", "bundle", "insights", "stats", "explain"]) {
        const removed = await runCli([gone]);
        equal(removed.exitCode, 2, `the deleted verb ${gone} exits 2`);
        assertion(removed.stdout.includes("unknown command"), `the deleted verb ${gone} reads as unknown`);
      }
    }, ["install"]);

    await scenario("setup", "Configure both assistants, and run what the skills say to run", "setup", async ({ assertion, equal }) => {
      // There is no `init`. The first optimize collects the one consent that
      // verb existed for: which assistants to optimize.
      const result = await runCli(["optimize", "--target", "both"]);
      equal(result.exitCode, 0, "first optimize with an explicit target succeeds");
      const config = await readJson(configPath);
      equal(config.targets, ["claude-code", "codex"], "the target choice is persisted");
      equal((await stat(configPath)).mode & 0o077, 0, "Gradient config is private");

      // gradient arrives by copy, so it installs no skill of its own. Writing
      // into an assistant's skill directory would mean two gradients on one
      // machine disagreeing about which runner is current.
      assertion(!(await pathExists(join(state.home, ".claude", "skills"))),
        "optimize writes nothing into Claude Code's skills directory");

      /**
       * The gate. A SKILL.md is markdown an agent obeys, so a command in it
       * that does not resolve is not a degraded skill — it is a skill that can
       * do nothing, and nothing finds out until an agent runs it.
       *
       * This ran green for a release whose every skill said a bare `gradient`,
       * which existed only after a global npm install. It has to run the
       * command, on a PATH with no `gradient` on it, in both shapes.
       */
      const shapes = [
        ...SKILLS.map(name => ({
          label: `codex ${codexName(name)}`,
          body: join(state.home, ".codex", "skills", codexName(name), "SKILL.md"),
          // The copied skill resolves its runner under the home it was
          // installed into, so HOME here is that home. The harness isolates
          // gradient's state with GRADIENT_HOME and leaves HOME real, which for
          // this one proof would point at the developer's own machine.
          env: { ...state.productEnv, HOME: state.home },
        })),
        ...SKILLS.map(name => ({
          label: `plugin ${name}`,
          body: join(state.pluginRoot, "skills", name, "SKILL.md"),
          env: { ...state.productEnv, CLAUDE_PLUGIN_ROOT: state.pluginRoot },
        })),
      ];
      for (const shape of shapes) {
        const body = await readFile(shape.body, "utf8");
        const runner = /(node "[^"]*gradient\.mjs[^"]*")/.exec(body);
        assertion(runner !== null, `${shape.label} names a concrete command to run`);
        const proof = await command(
          `${runner[1]} --version`,
          "/bin/sh",
          ["-c", `${runner[1]} --version`],
          { cwd: state.project, env: shape.env },
        );
        equal(proof.exitCode, 0, `${shape.label}'s own command runs with no gradient on PATH`);
        equal(proof.stdout.trim(), state.package.version, `${shape.label}'s command is this version`);
        assertion(!/npx|npm /.test(body), `${shape.label} tells no one to reach for a package manager`);
      }

      // The same command has to find a hand copy too. Codex reads both roots,
      // and a skill that resolves in only the one it happened to be installed
      // into is the same silent break, one directory over.
      const handCopy = join(state.sandbox, "hand-copy-home");
      await cp(join(repoRoot, "skills", codexName("report")),
        join(handCopy, ".agents", "skills", codexName("report")), { recursive: true });
      const body = await readFile(join(handCopy, ".agents", "skills", codexName("report"), "SKILL.md"), "utf8");
      const runner = /(node "[^"]*gradient\.mjs[^"]*")/.exec(body)[1];
      const elsewhere = await command(
        `${runner} --version`, "/bin/sh", ["-c", `${runner} --version`],
        { cwd: state.project, env: { ...state.productEnv, HOME: handCopy } },
      );
      equal(elsewhere.stdout.trim(), state.package.version,
        "the same command resolves a hand copy under ~/.agents/skills");

      // Non-interactive with no configuration must never guess.
      await updateConfig({ targets: undefined });
      const guessless = await runCli(["optimize"]);
      equal(guessless.exitCode, 1, "an unconfigured non-interactive run fails rather than guessing");
      assertion(guessless.stdout.includes("--target"), "the failure names the flag to pass");
      await updateConfig({ targets: ["claude-code", "codex"], backend: "claude-cli" });
    }, ["surface"]);

    await scenario("mine", "Mine synthetic Claude Code and Codex histories with no model", "mining", async ({ assertion, equal }) => {
      const both = await runCli(["optimize"]);
      equal(both.exitCode, 0, "project optimize succeeds");
      assertion(both.stdout.includes("Claude Code") && both.stdout.includes("Codex"), "optimize reports both transcript sources");
      assertion(both.stdout.includes("restatement filter"),
        "an artifact that would only repeat its own prompt is refused, and says so");
      const cached = await readJson(await suggestionsPath());
      assertion(cached.length > 0, "optimize persists its suggestions in the isolated cache");

      const user = await runCli(["optimize", "--user", "--since", "30d"]);
      equal(user.exitCode, 0, "bounded cross-project optimize succeeds");
      assertion(user.stdout.includes("user scope"), "cross-project scope is visible in output");

      await updateConfig({ targets: ["codex"] });
      const codex = await runCli(["optimize"]);
      equal(codex.exitCode, 0, "Codex-only optimize succeeds");
      assertion(codex.stdout.includes("sources: Claude Code 0 prompt(s) · Codex"), "the Codex collector supplies the mined prompts");
      await updateConfig({ targets: ["claude-code", "codex"] });
    }, ["setup"]);

    await scenario("propose", "Expose findings as JSON for an assistant to drive", "review", async ({ assertion, equal }) => {
      const json = await runCli(["optimize", "--json"]);
      equal(json.exitCode, 0, "optimize --json succeeds");
      assertion(!json.stdout.startsWith("gradient ·"), "--json prints no banner, so stdout parses");
      const parsed = JSON.parse(json.stdout);
      assertion(Array.isArray(parsed.findings), "the JSON carries a findings array");
      assertion(Array.isArray(parsed.targets) && parsed.targets.length > 0, "the JSON names the configured targets");
      for (const finding of parsed.findings) {
        assertion(typeof finding.id === "string" && finding.id.length > 0, "every finding has an id to apply by");
        assertion(typeof finding.evidence === "string", "every finding carries a quotable evidence line");
        assertion(typeof finding.autoEligible === "boolean", "every finding says whether --auto may take it");
      }
      const report = await runCli([]);
      equal(report.exitCode, 0, "the report succeeds alongside pending findings");
      const sessionStart = await runCli(["session-start"]);
      equal(sessionStart.exitCode, 0, "session-start hook target exits zero");

      // The checkup page is a file:// page precisely so it can be proven to
      // reference nothing outside itself.
      const paged = await runCli(["optimize", "--page"]);
      equal(paged.exitCode, 0, "optimize --page succeeds");
      const pagePath = /file:\/\/(\S+)/.exec(paged.stdout)?.[1];
      assertion(Boolean(pagePath), "the run names the page it wrote");
      const pageHtml = await readFile(pagePath, "utf8");
      assertion(pageHtml.startsWith("<!doctype html>"), "the page is a complete document");
      assertion(!/https?:\/\//.test(pageHtml), "the page references no external host");
      assertion(!/\bsrc\s*=|\bhref\s*=|<link\b/i.test(pageHtml), "the page loads no external asset");
      // The page's entire output is a command to copy, so it has to be one that
      // runs. A bare `gradient` resolves nowhere now.
      assertion(/gradient\.mjs optimize/.test(pageHtml), "the page carries a runnable apply command");
      assertion(!/"gradient optimize"/.test(pageHtml), "the page never offers a bare `gradient` to copy");

      // The scheduled/headless surface: printed, never installed.
      const schedule = await runCli(["optimize", "--print-schedule"]);
      equal(schedule.exitCode, 0, "--print-schedule succeeds");
      // A cron entry runs with a minimal environment and no shell profile, so a
      // snippet naming anything that needs PATH is the first thing to stop
      // working — silently, at 9am on a Monday.
      // Absolute node too, not just the absolute runner: the first version of
      // this assertion checked only the runner path and passed on a snippet
      // that said `node ~/...`, which launchd's PATH cannot resolve.
      assertion(schedule.stdout.includes(`${process.execPath} ${state.cliBin} optimize --auto`),
        "the snippet names an absolute node and this install's own runner");
      assertion(!/[^/]\bnode ~/.test(schedule.stdout),
        "the snippet leaves nothing for a scheduler's minimal PATH to resolve");
    }, ["mine"]);

    await scenario("bridge", "Bridge AGENTS.md into CLAUDE.md, then undo it", "artifacts", async ({ assertion, equal }) => {
      // Claude Code reads CLAUDE.md and never AGENTS.md. This is the change
      // that makes one setup serve both assistants, so it is the one the
      // packaged binary has to get right end to end.
      const claudeMd = join(state.project, "CLAUDE.md");
      const agentsMd = join(state.project, "AGENTS.md");
      const original = "# Project\n\n- Keep this hand-written line exactly as it is.\n";
      await writeFile(agentsMd, "- Shared guidance for every agent in this repository.\n", { mode: 0o644 });
      await writeFile(claudeMd, original, { mode: 0o644 });

      const proposed = JSON.parse((await runCli(["optimize", "--json"])).stdout);
      const drift = proposed.findings.find(finding => finding.family === "drift");
      assertion(Boolean(drift), "the missing bridge is reported");
      equal(drift.severity, "high", "the bridge is the highest-severity finding");
      equal(drift.changes[0].op, "prepend-import", "the proposed change is the documented one-line import");

      const applied = await runCli(["optimize", "--apply", drift.id]);
      equal(applied.exitCode, 0, "applying the bridge succeeds");
      const bridged = await readFile(claudeMd, "utf8");
      assertion(bridged.startsWith("@AGENTS.md"), "the import is the first line");
      assertion(bridged.includes("Keep this hand-written line exactly as it is."), "hand-written prose survives");

      const runId = /--undo (\S+)/.exec(applied.stdout)?.[1];
      assertion(Boolean(runId), "the run names itself for undo");
      const undone = await runCli(["optimize", "--undo", runId]);
      equal(undone.exitCode, 0, "undo succeeds");
      equal(await readFile(claudeMd, "utf8"), original, "undo restores the file byte for byte");

      // Re-apply and leave it bridged: later scenarios read a bridged repo.
      const again = JSON.parse((await runCli(["optimize", "--json"])).stdout);
      const rebridge = again.findings.find(finding => finding.family === "drift");
      await runCli(["optimize", "--apply", rebridge.id]);
      const after = JSON.parse((await runCli(["optimize", "--json"])).stdout);
      assertion(!after.findings.some(finding => finding.family === "drift"), "a bridged repo stops proposing the bridge");
    }, ["propose"]);

    await scenario("artifact-matrix", "Apply every generated artifact family and inspect ownership", "artifacts", async ({ assertion, equal }) => {
      await updateConfig({ targets: ["claude-code", "codex"], backend: "claude-cli" });
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
      // Applying by name: the report lists pending suggestions by name, and
      // --apply does not re-mine, so the seeded cache is what it reads.
      const applied = await runCli(["optimize", "--apply", suggestions.map(suggestion => suggestion.name).join(",")]);
      equal(applied.exitCode, 0, "full artifact matrix applies through the installed CLI");
      assertion(applied.stdout.includes("applied"), "the run reports what it applied");

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
      // A rule reaches Codex as one tagged line under gradient's own heading in
      // AGENTS.md, because Codex has no rules directory.
      const agents = await readFile(join(state.project, "AGENTS.md"), "utf8");
      assertion(agents.includes("## gradient"), "the Codex rule lands under gradient's own heading");
      assertion(agents.includes("<!-- gradient:dogfoodrule -->"), "the Codex rule is a tagged line");
      const report = await runCli([]);
      equal(report.exitCode, 0, "the bare report succeeds with artifacts installed");
      for (const name of ["dogfood-skill", "dogfood-rule", "dogfood-playbook"]) {
        assertion(report.stdout.includes(name), `the report's installed section includes ${name}`);
      }

      const tamperPath = join(state.project, ".claude", "skills", "dogfood-tamper", "SKILL.md");
      await writeFile(tamperPath, "hand-edited content without provenance\n", { mode: 0o600 });
      const refused = await runCli(["remove", "dogfood-tamper"]);
      equal(refused.exitCode, 1, "tampered artifact removal is refused");
      assertion(await pathExists(tamperPath), "tampered artifact remains untouched after refusal");
    }, ["bridge"]);

    await scenario("recall", "Exit silently on a leftover recall hook", "runtime", async ({ assertion, equal }) => {
      // `recall` is deleted. Its subcommand still exits silently because it ran
      // on UserPromptSubmit, whose stdout the model reads as context: falling
      // through to the unknown-command handler would inject usage text into a
      // live session.
      const hook = await runCli(["recall"], {
        input: JSON.stringify({ prompt: "anything at all", cwd: state.project, session_id: "dogfood-recall" }),
      });
      equal(hook.exitCode, 0, "the removed hook target exits zero");
      equal(hook.stdout, "", "the removed hook target prints nothing into the session");
      assertion(hook.stderr === "" || !hook.stderr.includes("unknown"), "nothing reaches stderr either");
    }, ["artifact-matrix"]);

    await scenario("apply-flow", "Apply, deny, and refuse to auto-apply prose edits", "review", async ({ assertion, equal }) => {
      // A stale reference is the family that edits prose a person wrote, so it
      // is the one --auto must never take.
      const claudeMd = join(state.project, "CLAUDE.md");
      const before = await readFile(claudeMd, "utf8");
      await writeFile(claudeMd, `${before}- Build it with \`scripts/gone.sh\` before committing.\n`, { mode: 0o644 });

      const proposed = JSON.parse((await runCli(["optimize", "--json"])).stdout);
      const stale = proposed.findings.find(finding => finding.family === "stale");
      assertion(Boolean(stale), "the stale reference is reported");
      equal(stale.autoEligible, false, "a prose edit is never eligible for --auto");

      const auto = await runCli(["optimize", "--auto"]);
      equal(auto.exitCode, 0, "--auto succeeds");
      assertion((await readFile(claudeMd, "utf8")).includes("scripts/gone.sh"), "--auto leaves hand-written prose alone");

      const applied = await runCli(["optimize", "--apply", stale.id]);
      equal(applied.exitCode, 0, "applying the stale line explicitly succeeds");
      assertion(!(await readFile(claudeMd, "utf8")).includes("scripts/gone.sh"), "the stale line is removed on explicit approval");

      const runId = /--undo (\S+)/.exec(applied.stdout)?.[1];
      await runCli(["optimize", "--undo", runId]);
      assertion((await readFile(claudeMd, "utf8")).includes("scripts/gone.sh"), "undo restores the removed line");
      await writeFile(claudeMd, before, { mode: 0o644 });
    }, ["recall"]);

    await scenario("insights", "Render the composed report from real state", "reporting", async ({ assertion, equal }) => {
      const report = await runCli([]);
      equal(report.exitCode, 0, "the bare report succeeds");
      assertion(report.stdout.includes("installed") && report.stdout.includes("use(s)"),
        "the report composes the adoption evidence that `stats` used to print separately");
      assertion(report.stdout.includes("features:"), "the report states which background features are on");
      assertion(report.stdout.includes("prompts"), "the report summarizes measured behavior");
    }, ["apply-flow"]);

    await scenario("continuity", "Round-trip continuity hooks, checkpoint, and recap", "runtime", async ({ assertion, equal }) => {
      const on = await runCli(["on", "continuity"]);
      equal(on.exitCode, 0, "continuity enable succeeds");
      assertion(on.stdout.includes("continuity on"), "the consent verb names what it turned on");
      const statusOn = await runCli([]);
      assertion(/continuity\s+on/.test(statusOn.stdout), "the report shows continuity on");
      const checkpoint = await runCli(["checkpoint"], { input: JSON.stringify({ transcript_path: state.claudeTranscript }) });
      equal(checkpoint.exitCode, 0, "checkpoint hook exits zero");
      equal(checkpoint.stdout, "", "checkpoint hook keeps stdout empty");
      const recap = await runCli(["recap"]);
      equal(recap.exitCode, 0, "recap succeeds");
      assertion(recap.stdout.includes("gradient-continuity-note") && recap.stdout.includes("Progress checkpoint"), "recap returns bounded untrusted checkpoint context");
      assertion(!recap.stdout.includes(SECRET_SENTINEL), "checkpoint/recap redacts the secret sentinel");
      const off = await runCli(["off", "continuity"]);
      equal(off.exitCode, 0, "continuity disable succeeds");
      const statusOff = await runCli([]);
      assertion(/continuity\s+off/.test(statusOff.stdout), "the report shows continuity off");

      // The scheduled loop: SessionEnd keeps findings current, SessionStart is
      // where they surface. One consent installs and removes both.
      const settingsPath = join(state.project, ".claude", "settings.local.json");
      const optimizeOn = await runCli(["on", "optimize"]);
      equal(optimizeOn.exitCode, 0, "optimize feature enable succeeds");
      const withLoop = await readJson(settingsPath);
      assertion(
        runsSubcommand(withLoop, "SessionEnd", "session-end") &&
        runsSubcommand(withLoop, "SessionStart", "session-start"),
        "both halves of the loop are installed together",
      );
      const ended = await runCli(["session-end"]);
      equal(ended.exitCode, 0, "the SessionEnd hook target exits zero");
      equal(ended.stdout, "", "the SessionEnd hook target is silent");
      const endedAgain = await runCli(["session-end"]);
      equal(endedAgain.exitCode, 0, "a second SessionEnd within the debounce window still exits zero");

      const optimizeOff = await runCli(["off", "optimize"]);
      equal(optimizeOff.exitCode, 0, "optimize feature disable succeeds");
      const withoutLoop = await readJson(settingsPath);
      assertion(
        !runsSubcommand(withoutLoop, "SessionEnd", "session-end") &&
        !runsSubcommand(withoutLoop, "SessionStart", "session-start"),
        "both halves are removed together",
      );
    }, ["insights"]);

    await scenario("board", "Observe live sessions, change-only refresh, and consent cleanup", "runtime", async ({ assertion, equal }) => {
      // The manual board view folded into the bare report; there is no verb.
      const manual = await runCli([]);
      equal(manual.exitCode, 0, "the report renders the board without prior consent");
      assertion(manual.stdout.includes("other sessions"), "the report discovers the synthetic concurrent sessions");
      assertion(manual.stdout.includes("claude") && manual.stdout.includes("codex"), "the report identifies both agent families");
      assertion(manual.stdout.includes("editing: README.md"), "the report derives bounded edited-file context");
      assertion(!manual.stdout.includes(SECRET_SENTINEL), "the report redacts the secret sentinel");

      const withoutConsent = await runCli(["hook", "board-digest"], {
        input: JSON.stringify({ session_id: "claude-dogfood-1" }),
      });
      equal(withoutConsent.exitCode, 0, "board digest fails open before consent");
      equal(withoutConsent.stdout, "", "board digest stays silent before consent");

      const on = await runCli(["on", "board"]);
      equal(on.exitCode, 0, "board enable succeeds");
      const enabledConfig = await readJson(configPath);
      equal(enabledConfig.boardProjects, [await realpath(state.project)], "board consent is isolated to the synthetic repository root");
      const settingsPath = join(state.project, ".claude", "settings.local.json");
      const settingsOn = await readJson(settingsPath);
      assertion(
        runsSubcommand(settingsOn, "SessionStart", "board digest") &&
        runsSubcommand(settingsOn, "UserPromptSubmit", "board refresh"),
        "board installs both project hooks",
      );

      const digest = await runCli(["hook", "board-digest"], {
        input: JSON.stringify({ session_id: "claude-dogfood-1" }),
      });
      equal(digest.exitCode, 0, "consented board digest succeeds");
      assertion(digest.stdout.includes("<gradient-board>") && digest.stdout.includes("untrusted data"), "hook digest is explicitly wrapped as untrusted data");
      assertion(digest.stdout.includes("3 other sessions") && digest.stdout.includes("(you) claude"), "hook digest excludes and marks the caller");
      assertion(!digest.stdout.includes(SECRET_SENTINEL), "hook digest contains no secret sentinel");

      const boardDir = join(await projectCacheDir(), "board");
      const seenPath = join(boardDir, "seen", "claude-dogfood-1");
      assertion(await pathExists(seenPath), "board digest records an isolated refresh baseline");
      equal((await stat(seenPath)).mode & 0o077, 0, "board refresh baseline is private");
      const unchanged = await runCli(["hook", "board-refresh"], {
        input: JSON.stringify({ session_id: "claude-dogfood-1" }),
      });
      equal(unchanged.exitCode, 0, "unchanged board refresh succeeds");
      equal(unchanged.stdout, "", "unchanged board refresh stays silent");

      await writeFile(join(state.project, "board-landed.txt"), "synthetic board change\n", { mode: 0o644 });
      const boardAdd = await command("git add board-landed.txt", "git", ["add", "board-landed.txt"], { cwd: state.project, env: process.env });
      equal(boardAdd.exitCode, 0, "board change is staged");
      const boardCommit = await command("git commit --quiet -m 'dogfood board landed change'", "git", ["commit", "--quiet", "-m", "dogfood board landed change"], {
        cwd: state.project,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Gradient Dogfood",
          GIT_AUTHOR_EMAIL: "dogfood@example.invalid",
          GIT_COMMITTER_NAME: "Gradient Dogfood",
          GIT_COMMITTER_EMAIL: "dogfood@example.invalid",
        },
      });
      equal(boardCommit.exitCode, 0, "main advances after the digest baseline");
      const baseline = await readJson(seenPath);
      await writeJson(seenPath, { ...baseline, checkedAt: Date.now() - 60_000 });
      const changed = await runCli(["hook", "board-refresh"], {
        input: JSON.stringify({ session_id: "claude-dogfood-1" }),
      });
      equal(changed.exitCode, 0, "changed board refresh succeeds");
      assertion(changed.stdout.startsWith("board:") && changed.stdout.includes("landed on main"), "changed board refresh emits one actionable delta line");

      const off = await runCli(["off", "board"]);
      equal(off.exitCode, 0, "board disable succeeds");
      const disabledConfig = await readJson(configPath);
      equal(disabledConfig.boardProjects, [], "board disable revokes repository consent");
      const settingsOff = await readJson(settingsPath);
      assertion(
        !runsSubcommand(settingsOff, "SessionStart", "board digest") &&
        !runsSubcommand(settingsOff, "UserPromptSubmit", "board refresh"),
        "board disable removes only its hooks",
      );
      assertion(!(await pathExists(boardDir)), "board disable removes private board state");
      const staleHook = await runCli(["hook", "board-digest"], {
        input: JSON.stringify({ session_id: "claude-dogfood-1" }),
      });
      equal(staleHook.exitCode, 0, "stale board hook remains fail-open after consent removal");
      equal(staleHook.stdout, "", "stale board hook is inert after consent removal");
      const unknown = await runCli(["on", "sideways"]);
      equal(unknown.exitCode, 2, "an unknown feature is a usage error");
      assertion(unknown.stdout.includes("unknown feature"), "the usage error names the problem");
    }, ["continuity"]);

    await scenario("autopilot", "Exercise autopilot continue, progress, stand-down, and consent removal", "runtime", async ({ assertion, equal }) => {
      await updateConfig({ backend: "claude-cli", targets: ["claude-code", "codex"] });
      const on = await runCli(["on", "autopilot"]);
      equal(on.exitCode, 0, "autopilot enable succeeds");
      // `autopilot status` was its own verb; its detail block folded into the
      // report, which is what let the verb go.
      const statusOn = await runCli([]);
      assertion(statusOn.stdout.includes("autopilot") && statusOn.stdout.includes("nudge"),
        "the report shows autopilot's mode when it is on");

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
      const statusAfter = await runCli([]);
      assertion(statusAfter.stdout.includes("deterministic dogfood stand-down"), "the report records the deterministic judge decision");
      const off = await runCli(["off", "autopilot"]);
      equal(off.exitCode, 0, "autopilot disable succeeds");
      const statusOff = await runCli([]);
      assertion(!statusOff.stdout.includes("stood down"), "the autopilot block disappears once it is off");
      const settingsOff = await readJson(join(state.project, ".claude", "settings.local.json"));
      assertion(!runsSubcommand(settingsOff, "Stop", "respond"), "autopilot consent and hook are removed together");
    }, ["board"]);

    await scenario("hook-contracts", "Verify notification and malformed hook inputs fail open", "runtime", async ({ assertion, equal }) => {
      const notify = await runCli(["notify"], { input: JSON.stringify({ hook_event_name: "Notification" }) });
      equal(notify.exitCode, 0, "notification hook exits zero without desktop support");
      equal(notify.stdout, "", "notification hook is silent");
      for (const name of ["recall", "checkpoint", "respond", "hook board-digest", "hook board-refresh"]) {
        const result = await runCli(name.split(" "), { input: "{malformed" });
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
      const corruptConfig = await runCli(["optimize"]);
      equal(corruptConfig.exitCode, 1, "corrupt config fails closed");
      assertion(corruptConfig.stdout.includes("refusing unreadable gradient config"), "corrupt config refusal is explicit");
      await writeFile(configPath, savedConfig, { mode: 0o600 });

      const cachePath = await suggestionsPath();
      await writeFile(cachePath, "{broken", { mode: 0o600 });
      const corruptCache = await runCli(["optimize", "--json", "--apply", "anything"]);
      equal(corruptCache.exitCode, 0, "corrupt suggestion cache degrades safely");
      equal(JSON.parse(corruptCache.stdout).findings.filter(f => f.family === "workflow"), [],
        "corrupt cache exposes no mined workflow");

      await writeFile(cachePath, `[${" ".repeat(5_000_100)}]`, { mode: 0o600 });
      const oversized = await runCli(["optimize", "--json", "--apply", "anything"]);
      equal(oversized.exitCode, 0, "oversized suggestion cache degrades safely");
      equal(JSON.parse(oversized.stdout).findings.filter(f => f.family === "workflow"), [],
        "oversized cache exposes no mined workflow");

      const outside = join(state.sandbox, "outside-suggestions.json");
      await writeJson(outside, [baseSuggestion("symlinkescape", "symlink-escape", {
        type: "command", commandName: "symlink-escape", body: "must never load", triggers: ["never load"],
      })]);
      await rm(cachePath, { force: true });
      await symlink(outside, cachePath);
      const linked = await runCli(["optimize", "--json", "--apply", "symlink-escape"]);
      equal(linked.exitCode, 0, "symlinked suggestion cache is refused without crashing");
      assertion(!linked.stdout.includes("symlink-escape") || !linked.stdout.includes("must never load"),
        "symlink target content is not loaded");
      await rm(cachePath, { force: true });
      await seedSuggestions([]);
    }, ["setup", "hook-contracts"]);

    await scenario("cleanup", "Remove owned artifacts and feature consent without collateral changes", "lifecycle", async ({ assertion, equal }) => {
      const before = await readJson(join(state.project, ".claude", "settings.local.json"));
      const removedHook = await runCli(["remove", "dogfood-notify"]);
      equal(removedHook.exitCode, 0, "owned hook removal succeeds");
      const after = await readJson(join(state.project, ".claude", "settings.local.json"));
      assertion(!runsSubcommand(after, "Notification", "notify"), "owned notification hook is removed");
      assertion(JSON.stringify(after).includes("npm run lint") === JSON.stringify(before).includes("npm run lint"), "adjacent reviewed command hook is preserved");

      // Hand-written prose beside gradient's own tagged line. The old
      // interactive-review scenario happened to leave this behind; writing it
      // here makes the property the assertion actually tests explicit.
      const playbookPath = join(state.project, "gradient.md");
      await writeFile(playbookPath, `${await readFile(playbookPath, "utf8")}\n- Manually reviewed dogfood note.\n`, { mode: 0o644 });

      const removedPlaybook = await runCli(["remove", "dogfood-playbook"]);
      equal(removedPlaybook.exitCode, 0, "tagged project-playbook removal succeeds");
      const playbook = await readFile(join(state.project, "gradient.md"), "utf8");
      assertion(!playbook.includes("<!-- gradient:dogfoodplaybook -->"), "only the owned tagged line is removed");
      assertion(playbook.includes("Manually reviewed dogfood note"), "manual playbook prose survives removal");

      const featureOff = await runCli(["off", "board"]);
      equal(featureOff.exitCode, 0, "feature consent removal succeeds");
      const finalReport = await runCli([]);
      assertion(/board\s+off/.test(finalReport.stdout), "the report shows the feature consent removed");
    }, ["artifact-matrix", "apply-flow", "security"]);

    await scenario("evidence", "Validate evidence hygiene and private state modes", "evidence", async ({ assertion, equal }) => {
      const approvalPath = join(await projectCacheDir(), "artifact-approvals.json");
      assertion(await pathExists(approvalPath), "private artifact approval ledger exists");
      const privatePaths = [
        configPath,
        await suggestionsPath(),
        approvalPath,
        join(await projectCacheDir(), "playbook-pin.json"),
        join(state.home, ".config", "gradient", "state", "dogfood-autopilot.json"),
      ];
      for (const path of privatePaths) {
        assertion(await pathExists(path), `${relative(state.home, path)} exists`);
        equal((await stat(path)).mode & 0o077, 0, `${relative(state.home, path)} is private`);
      }
      // recall is deleted, and its retirement removes the derived state it wrote.
      for (const name of ["recall.json", "recall.adoption.jsonl"]) {
        assertion(!(await pathExists(join(await projectCacheDir(), name))),
          `retired ${name} is not left behind`);
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
