import assert from "node:assert/strict";
import test from "node:test";
import { checkTargets } from "../scripts/build-allowlist.mjs";
import { checkWorkerTargets } from "../scripts/build-workers.mjs";

test("worker files are assembled from the template + fragments (codegen drift guard)", async () => {
  assert.deepEqual(await checkWorkerTargets(), []);
});

test("worker files are in sync with allowlist.json (codegen drift guard)", async () => {
  assert.deepEqual(await checkTargets(), []);
});
