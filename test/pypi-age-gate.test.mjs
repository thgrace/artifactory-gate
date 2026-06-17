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

const WORKER = "workers/pypi-age-gate.before-remote-download.ts";
const FIXTURE = "test/fixtures/before-remote-download-event.json";

// The fixture is npm-shaped; the pypi worker hardcodes its system, so dispatch
// ignores repoPath.key. Override the path to a PyPI layout for each case.
async function pypiEvent(path) {
  const event = clone(await readJson(FIXTURE));
  event.metadata.repoPath.key = "pypi-remote";
  event.metadata.repoPath.path = path;
  return event;
}

test("old PyPI sdist proceeds and queries deps.dev with the right URL", async () => {
  const worker = await loadWorker(WORKER);
  const event = await pypiEvent("packages/source/r/requests/requests-2.31.0.tar.gz");
  const { context, getCalls } = makeContext({ response: depsDevResponse(100) });

  const result = await worker(context, event);

  assert.equal(result.status, "PROCEED");
  assert.match(result.message, /allowed pypi:requests@2\.31\.0/);
  assert.equal(getCalls.length, 1);
  assert.equal(
    getCalls[0].getUrl,
    `${DEPS_DEV_BASE}/v3/systems/pypi/packages/requests/versions/2.31.0`
  );
  assert.equal(getCalls[0].options?.timeout, undefined);
});

test("PyPI wheel is parsed and queried", async () => {
  const worker = await loadWorker(WORKER);
  const event = await pypiEvent("packages/py3/r/requests/requests-2.31.0-py3-none-any.whl");
  const { context, getCalls } = makeContext({ response: depsDevResponse(100) });

  const result = await worker(context, event);

  assert.equal(result.status, "PROCEED");
  assert.equal(
    getCalls[0].getUrl,
    `${DEPS_DEV_BASE}/v3/systems/pypi/packages/requests/versions/2.31.0`
  );
});

test("young PyPI package stops (blocked)", async () => {
  const worker = await loadWorker(WORKER);
  const event = await pypiEvent("packages/source/r/requests/requests-2.31.0.tar.gz");
  const { context } = makeContext({ response: depsDevResponse(10) });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /blocked pypi:requests@2\.31\.0/);
});

test("deps.dev 404 fails closed (block)", async () => {
  const worker = await loadWorker(WORKER);
  const event = await pypiEvent("packages/source/r/requests/requests-2.31.0.tar.gz");
  const { context } = makeContext({
    error: Object.assign(new Error("not found"), { response: { status: 404 } })
  });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /not yet indexed/);
});

test("unparseable path fails closed without querying deps.dev", async () => {
  const worker = await loadWorker(WORKER);
  const event = await pypiEvent("simple/requests/index.html");
  const { context, getCalls } = makeContext({ response: depsDevResponse(100) });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /unparseable-path/);
  assert.equal(getCalls.length, 0);
});

test("PyPI allowlist label matches the worker's PEP 503 normalized name", async () => {
  // The worker normalizes parsed.name for pypi; the codegen must produce the
  // same normalized label or the bypass silently never matches.
  const worker = await loadWorker(WORKER, { allowlist: ["pypi:flask-foo@1.0.0"] });
  const event = await pypiEvent("packages/source/f/Flask_Foo/Flask_Foo-1.0.0.tar.gz");
  const { context, getCalls } = makeContext({ response: depsDevResponse(10) });

  const result = await worker(context, event);

  assert.equal(result.status, "PROCEED");
  assert.match(result.message, /allowed pypi:flask-foo@1\.0\.0 via allowlist/);
  assert.equal(getCalls.length, 0);
});
