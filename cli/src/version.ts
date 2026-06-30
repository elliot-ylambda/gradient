import { createRequire } from "node:module";

// Single source of truth: read the package's own version at runtime so the
// banner can never drift from package.json. createRequire resolves relative to
// this module's location (src/ in dev, dist/ when built) — both sit one level
// below package.json.
const require = createRequire(import.meta.url);

export const VERSION: string = (require("../package.json") as { version: string }).version;
