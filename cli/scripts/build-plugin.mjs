import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = join(cliDir, "..", "plugin");
const outfile = join(pluginDir, "bin", "gradient.mjs");

const pkg = JSON.parse(await readFile(join(cliDir, "package.json"), "utf8"));

await build({
  entryPoints: [join(cliDir, "src", "bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false, // the committed bundle stays diff-reviewable
  // src/version.ts normally reads its own version via
  // createRequire(import.meta.url)("../package.json"), which resolves fine
  // one level below cli/package.json (src/ or dist/) but NOT one level below
  // the bundle (plugin/bin/ → plugin/package.json, which doesn't exist —
  // plugin/ ships no package.json). Bake the version in at build time instead;
  // version.ts's `typeof __GRADIENT_BUNDLED_VERSION__ !== "undefined"` guard
  // picks this up only in the bundle, leaving the require() path untouched
  // (and the sole source of truth) for the normal tsc build.
  define: {
    __GRADIENT_BUNDLED_VERSION__: JSON.stringify(pkg.version),
  },
  // No "#!/usr/bin/env node" banner: esbuild already hoists bin.ts's own
  // leading shebang to the top of the bundle. Adding one here would
  // duplicate it, producing an invalid second shebang line that Node's
  // ESM loader rejects with a SyntaxError.
  //
  // A createRequire shim IS needed: bundled CJS dependencies (e.g.
  // node-fetch, pulled in transitively via @anthropic-ai/sdk) call the
  // plain Node `require()` for builtins like "stream". In `format: "esm"`
  // output there is no ambient `require`, so esbuild's interop shim has
  // nothing to fall through to and throws "Dynamic require ... is not
  // supported" at runtime.
  //
  // The alias + globalThis assignment (instead of a bare top-level
  // `const require`) matters: banner text is raw, unparsed source spliced
  // in ahead of the bundle, outside esbuild's identifier-renaming pass.
  // src/version.ts already does `import { createRequire } from
  // "node:module"` itself, so an unaliased `import { createRequire }`
  // here collides ("Identifier has already been declared"). Assigning to
  // globalThis avoids clashing with any module-local `require` too —
  // esbuild's generated __require shim reads the free `require`
  // identifier, which resolves through the global scope.
  banner: {
    js: "import { createRequire as __gradientCreateRequire } from 'node:module'; globalThis.require ??= __gradientCreateRequire(import.meta.url);",
  },
});

const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = pkg.version;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`plugin bundle → ${outfile} (v${pkg.version})`);
