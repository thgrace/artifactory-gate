import assert from "node:assert/strict";
import test from "node:test";
import {
  DEPS_DEV_BASE,
  clone,
  depsDevResponse,
  loadWorker,
  makeContext,
  readJson
} from "./worker-harness.mjs";

const WORKER = "workers/npm-age-gate.before-remote-download.ts";

// The fixture is an npm event (@scope/pkg@1.2.3).
const FIXTURE = "test/fixtures/before-remote-download-event.json";

test("old npm package proceeds and queries deps.dev with the right URL", async () => {
  const worker = await loadWorker(WORKER);
  const event = await readJson(FIXTURE);
  const { context, getCalls } = makeContext({ response: depsDevResponse(100) });

  const result = await worker(context, event);

  assert.equal(result.status, "PROCEED");
  assert.match(result.message, /allowed npm:@scope\/pkg@1\.2\.3/);
  assert.equal(getCalls.length, 1);
  assert.equal(
    getCalls[0].getUrl,
    `${DEPS_DEV_BASE}/v3/systems/npm/packages/%40scope%2Fpkg/versions/1.2.3`
  );
  // The JFrog sandbox axios rejects the `timeout` request option, so the worker
  // must not pass one (see worker source comment on API_TIMEOUT_MS).
  assert.equal(getCalls[0].options?.timeout, undefined);
});

test("young npm package stops (blocked)", async () => {
  const worker = await loadWorker(WORKER);
  const event = await readJson(FIXTURE);
  const { context } = makeContext({ response: depsDevResponse(10) });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /blocked npm:@scope\/pkg@1\.2\.3/);
});

test("deps.dev 404 fails closed (block)", async () => {
  const worker = await loadWorker(WORKER);
  const event = await readJson(FIXTURE);
  const { context } = makeContext({
    error: Object.assign(new Error("not found"), { response: { status: 404 } })
  });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /not yet indexed/);
});

test("deps.dev transport error stops (fail closed)", async () => {
  const worker = await loadWorker(WORKER);
  const event = await readJson(FIXTURE);
  const { context } = makeContext({
    error: Object.assign(new Error("connect timeout"), { response: { status: 503 } })
  });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /status=503/);
});

test("missing publishedAt fails closed (block)", async () => {
  const worker = await loadWorker(WORKER);
  const event = await readJson(FIXTURE);
  const { context } = makeContext({ response: { isDefault: false } });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /no usable publish time/);
});

test("unparseable path fails closed without querying deps.dev", async () => {
  const worker = await loadWorker(WORKER);
  const event = clone(await readJson(FIXTURE));
  event.metadata.repoPath.path = "@scope/pkg/some/weird/layout";
  const { context, getCalls } = makeContext({ response: depsDevResponse(100) });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /unparseable-path/);
  assert.equal(getCalls.length, 0);
});

test("missing repoPath stops without querying deps.dev", async () => {
  const worker = await loadWorker(WORKER);
  const event = clone(await readJson(FIXTURE));
  const { context, getCalls } = makeContext({ response: depsDevResponse(100) });
  delete event.metadata.repoPath;

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.equal(getCalls.length, 0);
  assert.match(result.message, /missing repoPath metadata/);
});

for (const field of ["headOnly", "checksum", "metadata"]) {
  test(`${field} request proceeds without querying deps.dev`, async () => {
    const worker = await loadWorker(WORKER);
    const event = clone(await readJson(FIXTURE));
    const { context, getCalls } = makeContext({ response: depsDevResponse(10) });
    event.metadata[field] = true;

    const result = await worker(context, event);

    assert.equal(result.status, "PROCEED");
    assert.equal(getCalls.length, 0);
    assert.match(result.message, /skipped non-content request/);
  });
}

test("allowlisted package proceeds without querying deps.dev", async () => {
  const worker = await loadWorker(WORKER, { allowlist: ["npm:@scope/pkg@1.2.3"] });
  const event = await readJson(FIXTURE);
  // A young response would normally STOP; the allowlist must bypass it entirely.
  const { context, getCalls } = makeContext({ response: depsDevResponse(10) });

  const result = await worker(context, event);

  assert.equal(result.status, "PROCEED");
  assert.match(result.message, /via allowlist/);
  assert.equal(getCalls.length, 0);
});

test("allowlist match is exact: a package not listed follows the normal flow", async () => {
  // Listing a different version must not bypass @scope/pkg@1.2.3.
  const worker = await loadWorker(WORKER, { allowlist: ["npm:@scope/pkg@9.9.9"] });
  const event = await readJson(FIXTURE);
  const { context, getCalls } = makeContext({ response: depsDevResponse(10) });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /blocked npm:@scope\/pkg@1\.2\.3/);
  assert.equal(getCalls.length, 1);
});
