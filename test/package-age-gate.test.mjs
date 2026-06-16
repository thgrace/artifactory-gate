import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { checkTargets } from "../scripts/build-allowlist.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const DEPS_DEV_BASE = "https://api.deps.dev";

async function readJson(path) {
  return JSON.parse(await readFile(resolve(rootDir, path), "utf8"));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function transpileWorkerSource(source) {
  return source
    .replace(
      "function safeString(value: any): string | undefined",
      "function safeString(value)"
    )
    .replace(
      "function detectEcosystem(repoKey: any): string | undefined",
      "function detectEcosystem(repoKey)"
    )
    .replace(
      "function normalizePyPiName(name: string): string",
      "function normalizePyPiName(name)"
    )
    .replace(
      "function parseNpm(path: string): { name: string; version: string } | undefined",
      "function parseNpm(path)"
    )
    .replace(
      "function parsePyPI(path: string): { name: string; version: string } | undefined",
      "function parsePyPI(path)"
    )
    .replace(
      "function computeAgeHours(publishedAt: any, now: number): number | undefined",
      "function computeAgeHours(publishedAt, now)"
    )
    .replace(
      `export default async (
  context: PlatformContext,
  data: BeforeRemoteDownloadRequest
): Promise<BeforeRemoteDownloadResponse> =>`,
      "worker = async (context, data) =>"
    )
    .replace("const err: any = error;", "const err = error;");
}

async function loadWorker({ allowlist } = {}) {
  let source = await readFile(
    resolve(rootDir, "workers/package-age-gate.before-remote-download.ts"),
    "utf8"
  );
  // The real allowlist.json ships empty, so the inlined block is `new Set([])`.
  // Inject labels to exercise the bypass path without touching allowlist.json.
  if (allowlist) {
    const literal = `new Set([${allowlist.map((label) => JSON.stringify(label)).join(", ")}])`;
    source = source.replace(/new Set\(\[[\s\S]*?\]\)/, literal);
  }
  const script = `let worker;\n${transpileWorkerSource(source)}\nworker;`;

  return vm.runInNewContext(script, {
    Date,
    Number,
    encodeURIComponent,
    ActionStatus: {
      PROCEED: "PROCEED",
      STOP: "STOP",
      WARN: "WARN"
    }
  });
}

// Build a deps.dev version response whose publishedAt is `ageHours` old.
function depsDevResponse(ageHours) {
  const publishedMs = Date.now() - ageHours * 3600000;
  return { publishedAt: new Date(publishedMs).toISOString() };
}

function makeContext({ response, error } = {}) {
  const getCalls = [];

  return {
    getCalls,
    context: {
      clients: {
        axios: {
          async get(getUrl, options) {
            getCalls.push({ getUrl, options });
            if (error) throw error;
            return { data: response };
          }
        }
      }
    }
  };
}

test("old npm package proceeds and queries deps.dev with the right URL", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
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
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const { context } = makeContext({ response: depsDevResponse(10) });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /blocked npm:@scope\/pkg@1\.2\.3/);
});

test("PyPI sdist is parsed and queried", async () => {
  const worker = await loadWorker();
  const event = clone(await readJson("test/fixtures/before-remote-download-event.json"));
  event.metadata.repoPath.key = "pypi-remote";
  event.metadata.repoPath.path = "packages/source/r/requests/requests-2.31.0.tar.gz";
  const { context, getCalls } = makeContext({ response: depsDevResponse(100) });

  const result = await worker(context, event);

  assert.equal(result.status, "PROCEED");
  assert.equal(
    getCalls[0].getUrl,
    `${DEPS_DEV_BASE}/v3/systems/pypi/packages/requests/versions/2.31.0`
  );
});

test("deps.dev 404 fails closed (block)", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const { context } = makeContext({
    error: Object.assign(new Error("not found"), { response: { status: 404 } })
  });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /not yet indexed/);
});

test("deps.dev transport error stops (fail closed)", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const { context } = makeContext({
    error: Object.assign(new Error("connect timeout"), { response: { status: 503 } })
  });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /status=503/);
});

test("missing publishedAt warns", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const { context } = makeContext({ response: { isDefault: false } });

  const result = await worker(context, event);

  assert.equal(result.status, "WARN");
  assert.match(result.message, /could not determine deps\.dev publish time/);
});

test("unsupported ecosystem warns without querying deps.dev", async () => {
  const worker = await loadWorker();
  const event = clone(await readJson("test/fixtures/before-remote-download-event.json"));
  event.metadata.repoPath.key = "maven-remote";
  const { context, getCalls } = makeContext({ response: depsDevResponse(100) });

  const result = await worker(context, event);

  assert.equal(result.status, "WARN");
  assert.match(result.message, /unsupported-ecosystem/);
  assert.equal(getCalls.length, 0);
});

test("unparseable path warns without querying deps.dev", async () => {
  const worker = await loadWorker();
  const event = clone(await readJson("test/fixtures/before-remote-download-event.json"));
  event.metadata.repoPath.path = "@scope/pkg/some/weird/layout";
  const { context, getCalls } = makeContext({ response: depsDevResponse(100) });

  const result = await worker(context, event);

  assert.equal(result.status, "WARN");
  assert.match(result.message, /unparseable-path/);
  assert.equal(getCalls.length, 0);
});

test("missing repoPath stops without querying deps.dev", async () => {
  const worker = await loadWorker();
  const event = clone(await readJson("test/fixtures/before-remote-download-event.json"));
  const { context, getCalls } = makeContext({ response: depsDevResponse(100) });
  delete event.metadata.repoPath;

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.equal(getCalls.length, 0);
  assert.match(result.message, /missing repoPath metadata/);
});

for (const field of ["headOnly", "checksum", "metadata"]) {
  test(`${field} request proceeds without querying deps.dev`, async () => {
    const worker = await loadWorker();
    const event = clone(await readJson("test/fixtures/before-remote-download-event.json"));
    const { context, getCalls } = makeContext({ response: depsDevResponse(10) });
    event.metadata[field] = true;

    const result = await worker(context, event);

    assert.equal(result.status, "PROCEED");
    assert.equal(getCalls.length, 0);
    assert.match(result.message, /skipped non-content request/);
  });
}

test("allowlisted package proceeds without querying deps.dev", async () => {
  const worker = await loadWorker({ allowlist: ["npm:@scope/pkg@1.2.3"] });
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  // A young response would normally STOP; the allowlist must bypass it entirely.
  const { context, getCalls } = makeContext({ response: depsDevResponse(10) });

  const result = await worker(context, event);

  assert.equal(result.status, "PROCEED");
  assert.match(result.message, /via allowlist/);
  assert.equal(getCalls.length, 0);
});

test("allowlist match is exact: a package not listed follows the normal flow", async () => {
  // Listing a different version must not bypass @scope/pkg@1.2.3.
  const worker = await loadWorker({ allowlist: ["npm:@scope/pkg@9.9.9"] });
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const { context, getCalls } = makeContext({ response: depsDevResponse(10) });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.match(result.message, /blocked npm:@scope\/pkg@1\.2\.3/);
  assert.equal(getCalls.length, 1);
});

test("PyPI allowlist label matches the worker's PEP 503 normalized name", async () => {
  // The worker normalizes parsed.name for pypi; the codegen must produce the
  // same normalized label or the bypass silently never matches.
  const worker = await loadWorker({ allowlist: ["pypi:flask-foo@1.0.0"] });
  const event = clone(await readJson("test/fixtures/before-remote-download-event.json"));
  event.metadata.repoPath.key = "pypi-remote";
  event.metadata.repoPath.path = "packages/source/f/Flask_Foo/Flask_Foo-1.0.0.tar.gz";
  const { context, getCalls } = makeContext({ response: depsDevResponse(10) });

  const result = await worker(context, event);

  assert.equal(result.status, "PROCEED");
  assert.match(result.message, /allowed pypi:flask-foo@1\.0\.0 via allowlist/);
  assert.equal(getCalls.length, 0);
});

test("worker files are in sync with allowlist.json (codegen drift guard)", async () => {
  assert.deepEqual(await checkTargets(), []);
});