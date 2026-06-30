import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { VERSION } from "./version.js";

const require = createRequire(import.meta.url);

describe("VERSION", () => {
  it("is the single source of truth — matches package.json", () => {
    const pkg = require("../package.json") as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
