import assert from "node:assert/strict";
import test from "node:test";

import { compareReleaseState, websiteVersion } from "./check-release-state.mjs";

test("extracts the deployed header version", () => {
  assert.equal(websiteVersion('<span class="ver">v0.4.0</span>'), "0.4.0");
  assert.equal(websiteVersion("<main>no version</main>"), null);
});

test("reports every inconsistent release surface", () => {
  assert.deepEqual(compareReleaseState("0.4.0", { npm: "0.4.0", "GitHub Release": "0.3.1", website: null }), [
    "GitHub Release: expected 0.4.0, found 0.3.1",
    "website: expected 0.4.0, found missing",
  ]);
  assert.deepEqual(compareReleaseState("0.4.0", { npm: "0.4.0", "GitHub Release": "0.4.0", website: "0.4.0" }), []);
});
