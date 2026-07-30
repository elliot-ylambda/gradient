import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOOK_BINARY, resolveHookBinary, shellQuote } from "./hookBinary.js";

function dirWithGradient(): string {
  const dir = mkdtempSync(join(tmpdir(), "gradient-hookbin-"));
  const bin = join(dir, DEFAULT_HOOK_BINARY);
  writeFileSync(bin, "#!/bin/sh\n");
  chmodSync(bin, 0o755);
  return dir;
}

describe("resolveHookBinary", () => {
  it("uses the bare command when gradient is on PATH", () => {
    const result = resolveHookBinary({ env: { PATH: dirWithGradient() } });
    expect(result).toEqual({ command: "gradient", durable: true });
  });

  it("ignores a PATH entry holding a non-executable file of the same name", () => {
    const dir = mkdtempSync(join(tmpdir(), "gradient-hookbin-"));
    writeFileSync(join(dir, DEFAULT_HOOK_BINARY), "not executable\n");
    chmodSync(join(dir, DEFAULT_HOOK_BINARY), 0o644);
    const result = resolveHookBinary({
      env: { PATH: dir },
      execPath: "/usr/bin/node",
      scriptPath: "/opt/gradient/bin.js",
    });
    expect(result.command).toBe("/usr/bin/node /opt/gradient/bin.js");
  });

  it("pins to the running install when gradient is absent but the path is stable", () => {
    const result = resolveHookBinary({
      env: { PATH: "/nonexistent" },
      execPath: "/usr/local/bin/node",
      scriptPath: "/opt/gradient/dist/bin.js",
    });
    expect(result.command).toBe("/usr/local/bin/node /opt/gradient/dist/bin.js");
    expect(result.durable).toBe(true);
    expect(result.warning).toMatch(/not on PATH/);
  });

  it("quotes paths containing spaces so the hook stays one command", () => {
    const result = resolveHookBinary({
      env: { PATH: "/nonexistent" },
      execPath: "/usr/bin/node",
      scriptPath: "/Users/a b/gradient/bin.js",
    });
    expect(result.command).toBe("/usr/bin/node '/Users/a b/gradient/bin.js'");
  });

  it("falls back to a pinned npx spec when running from an npx cache", () => {
    const result = resolveHookBinary({
      env: { PATH: "/nonexistent" },
      execPath: "/usr/bin/node",
      scriptPath: "/Users/me/.npm/_npx/abc123/node_modules/gradient.md/dist/bin.js",
      version: "9.9.9",
    });
    expect(result.command).toBe("npx -y gradient.md@9.9.9");
    expect(result.durable).toBe(false);
    expect(result.warning).toMatch(/npx/);
  });

  it("never emits a bare gradient when it is not on PATH", () => {
    for (const scriptPath of ["/opt/gradient/bin.js", "/x/_npx/y/bin.js"]) {
      const result = resolveHookBinary({ env: { PATH: "/nonexistent" }, scriptPath });
      expect(result.command).not.toBe(DEFAULT_HOOK_BINARY);
      expect(result.warning).toBeTruthy();
    }
  });

  it("treats a missing PATH as no gradient rather than throwing", () => {
    const result = resolveHookBinary({ env: {}, execPath: "/usr/bin/node", scriptPath: "/opt/g/bin.js" });
    expect(result.command).toBe("/usr/bin/node /opt/g/bin.js");
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
