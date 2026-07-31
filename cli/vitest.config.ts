import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Several suites shell out to git in a temporary repository. Vitest's 5s
    // default is enough on an idle machine and not enough when something else
    // holds a git lock — which, in a repository where gradient's own board
    // reports three concurrent sessions, is the normal case. The suite failed
    // spuriously for exactly this reason, on unmodified main.
    testTimeout: 20_000,
  },
});
