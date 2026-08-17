import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { displayCommand, gradientCommand, gradientHookCommand, isGradientHookFor, shellQuote } from "./hookBinary.js";

describe("gradientCommand", () => {
  it("runs this install's own entry point with this node", () => {
    expect(gradientCommand({ execPath: "/usr/local/bin/node", scriptPath: "/opt/gradient/bin/gradient.mjs" }))
      .toBe("/usr/local/bin/node /opt/gradient/bin/gradient.mjs");
  });

  it("quotes paths containing spaces so the hook stays one command", () => {
    expect(gradientCommand({ execPath: "/usr/bin/node", scriptPath: "/Users/a b/gradient/bin/gradient.mjs" }))
      .toBe("/usr/bin/node '/Users/a b/gradient/bin/gradient.mjs'");
  });

  /**
   * The defect this replaces: gradient shipped as a single-file bundle, and the
   * resolver looked for `../bin.js` beside its own module. In the bundle that
   * resolved to plugin/bin.js, which does not exist, so it concluded gradient
   * was unreachable and fell back to `npx -y gradient.md@<version>` — a registry
   * coordinate that need not be published for the build doing the pinning. The
   * plugin advertised "no npm needed" and then wrote npm into every hook, where
   * the failure is invisible because hooks have nowhere to report.
   */
  it("never reaches for a package manager, whatever it resolves to", () => {
    for (const scriptPath of [
      "/opt/gradient/bin/gradient.mjs",
      "/Users/me/.npm/_npx/abc123/node_modules/gradient.md/dist/bin.js",
      "/Users/me/.claude/plugins/cache/gradient/gradient/bin/gradient.mjs",
    ]) {
      // Compared whole: an npx path contains the string "npm", so a substring
      // check would pass on a command that shelled out to it.
      expect(gradientCommand({ execPath: "/usr/bin/node", scriptPath }))
        .toBe(`/usr/bin/node ${shellQuote(scriptPath)}`);
    }
  });

  // Emitting something unrunnable is the failure mode; refusing is recoverable.
  it("refuses rather than emitting a command that cannot run", () => {
    expect(() => gradientCommand({ scriptPath: null }))
      .toThrow(/cannot locate gradient's own entry point/);
  });

  it("resolves from its own location when nothing is injected", () => {
    expect(gradientCommand()).toContain(process.execPath);
  });
});

describe("shellQuote", () => {
  it("leaves ordinary paths alone", () => {
    expect(shellQuote("/usr/local/bin/node")).toBe("/usr/local/bin/node");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("/tmp/it's here/bin.js")).toBe(`'/tmp/it'\\''s here/bin.js'`);
  });
});

describe("isGradientHookFor", () => {
  /**
   * Removal has to recognise every form gradient has ever written, including
   * the two it no longer writes: a bare `gradient` from when npm put one on
   * PATH, and an npx spec from the fallback above. Machines that ran those
   * versions still have those hooks, and `off` is the only way out of them.
   */
  it("matches every binary form gradient may have installed", () => {
    for (const command of [
      "gradient recall",
      "/usr/bin/node /opt/gradient/dist/bin.js recall",
      "'/usr/bin/node' '/Users/a b/gradient/bin/gradient.mjs' recall",
      "npx -y gradient.md@0.6.1 recall",
    ]) {
      expect(isGradientHookFor(command, "recall")).toBe(true);
    }
  });

  it("matches multi-word subcommands", () => {
    expect(isGradientHookFor("/usr/bin/node /o/gradient/bin.js board digest", "board digest")).toBe(true);
    expect(isGradientHookFor("/usr/bin/node /o/gradient/bin.js board refresh", "board digest")).toBe(false);
  });

  it("never claims a hook that is not gradient's", () => {
    expect(isGradientHookFor("my-tool recall", "recall")).toBe(false);
    expect(isGradientHookFor("npm run recall", "recall")).toBe(false);
  });

  it("does not match a different gradient subcommand", () => {
    expect(isGradientHookFor("gradient notify", "recall")).toBe(false);
  });
});

describe("gradientHookCommand", () => {
  it("appends the subcommand, and what it writes is what removal matches", () => {
    const command = gradientHookCommand("checkpoint", {
      execPath: "/usr/bin/node",
      scriptPath: "/opt/gradient/bin/gradient.mjs",
    });
    expect(command).toBe("/usr/bin/node /opt/gradient/bin/gradient.mjs checkpoint");
    expect(isGradientHookFor(command, "checkpoint")).toBe(true);
  });
});

describe("displayCommand", () => {
  const home = "/Users/someone";
  const script = `${home}/.agents/skills/gradient-optimize/bin/gradient.mjs`;
  // A PATH that genuinely resolves `node` — this machine's own.
  const onPathEnv = { PATH: dirname(process.execPath) };

  it("shortens the home prefix, so a report never carries the user's account name", () => {
    expect(displayCommand({ execPath: "/opt/node/bin/node", scriptPath: script, home, env: onPathEnv }))
      .toBe("node ~/.agents/skills/gradient-optimize/bin/gradient.mjs");
  });

  it("keeps the absolute node when no node resolves on PATH to undo the shortening", () => {
    expect(displayCommand({ execPath: "/opt/node/bin/node", scriptPath: script, home, env: { PATH: "/nonexistent" } }))
      .toBe("/opt/node/bin/node ~/.agents/skills/gradient-optimize/bin/gradient.mjs");
  });

  /**
   * Tilde expansion is not word-split, so a space in the *home* part is fine —
   * but a space after it is, and would split the command in two. Quoting the
   * path instead would quote the tilde, which stops it expanding at all, so the
   * only correct answer is the absolute path.
   */
  it("stays absolute when the path below home needs quoting", () => {
    const spaced = `${home}/My Skills/gradient/bin/gradient.mjs`;
    expect(displayCommand({ execPath: "/opt/node/bin/node", scriptPath: spaced, home, env: onPathEnv }))
      .toBe(`/opt/node/bin/node '${spaced}'`);
  });

  it("stays absolute for a runner outside the home directory", () => {
    expect(displayCommand({ execPath: "/opt/node/bin/node", scriptPath: "/opt/gradient/bin/gradient.mjs", home, env: onPathEnv }))
      .toBe("/opt/node/bin/node /opt/gradient/bin/gradient.mjs");
  });
});
