import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  minify: false,
  // CLI entrypoint needs a shebang so `npx gradient` is directly executable.
  banner: { js: "#!/usr/bin/env node" },
});
