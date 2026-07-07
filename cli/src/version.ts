import { createRequire } from "node:module";

// Single source of truth: read the package's own version at runtime so the
// banner can never drift from package.json. createRequire resolves relative to
// this module's location (src/ in dev, dist/ when built) — both sit one level
// below package.json.
//
// The bundled plugin/bin/gradient.mjs has no such neighbor — plugin/ ships no
// package.json (see .superpowers/sdd/global-constraints.md) — so
// require("../package.json") would resolve to a nonexistent plugin/package.json
// and throw MODULE_NOT_FOUND at import time, crashing every command.
// build-plugin.mjs bakes the version in at build time via esbuild's `define`;
// __GRADIENT_BUNDLED_VERSION__ is left undefined (and this branch dead) for
// the normal tsc build, so require() stays the source of truth everywhere else.
declare const __GRADIENT_BUNDLED_VERSION__: string | undefined;

const require = createRequire(import.meta.url);

export const VERSION: string =
  typeof __GRADIENT_BUNDLED_VERSION__ !== "undefined"
    ? __GRADIENT_BUNDLED_VERSION__
    : (require("../package.json") as { version: string }).version;
