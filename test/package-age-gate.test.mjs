import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

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
      'function normalizeMode(rawMode: any): "enforce" | "audit"',
      "function normalizeMode(rawMode)"
    )
    .replace(
      "function formatPackageLabel(verdict: any, repoPath: any): string",
      "function formatPackageLabel(verdict, repoPath)"
    )
    .replace(
      "function buildHeaders(token: string): Record<string, string>",
      "function buildHeaders(token)"
    )
    .replace(
      `export default async (
  context: PlatformContext,
  data: BeforeRemoteDownloadRequest
): Promise<BeforeRemoteDownloadResponse> =>`,
      "worker = async (context, data) =>"
    )
    .replace(
      "const requestHeaders: { [key: string]: Header } = {};",
      "const requestHeaders = {};"
    )
    .replace("const err: any = error;", "const err = error;");
}

async function loadWorker() {
  const source = await readFile(
    resolve(rootDir, "workers/package-age-gate.before-remote-download.ts"),
    "utf8"
  );
  const script = `let worker;\n${transpileWorkerSource(source)}\nworker;`;

  return vm.runInNewContext(script, {
    ActionStatus: {
      PROCEED: "PROCEED",
      STOP: "STOP",
      WARN: "WARN"
    }
  });
}

function makeContext({ response, error, mode = "enforce", url, token } = {}) {
  const postCalls = [];
  const secrets = {
    PACKAGE_AGE_GATE_URL: url === undefined ? "https://policy.example.com/v1/package-age/verdict" : url,
    PACKAGE_AGE_GATE_TOKEN: token === undefined ? "test-token" : token,
    PACKAGE_AGE_GATE_MODE: mode
  };

  return {
    postCalls,
    context: {
      secrets: {
        get(name) {
          return secrets[name];
        }
      },
      clients: {
        axios: {
          async post(postUrl, payload, options) {
            postCalls.push({ postUrl, payload, options });
            if (error) throw error;
            return { data: response };
          }
        }
      }
    }
  };
}

function ageGateHeader(result) {
  return result.requestHeaders["X-Package-Age-Gate"].value[0];
}

test("allow decision proceeds and sends policy payload", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const allowResponse = await readJson("test/fixtures/allow-response.json");
  const { context, postCalls } = makeContext({ response: allowResponse });

  const result = await worker(context, event);

  assert.equal(result.status, "PROCEED");
  assert.equal(ageGateHeader(result), "allow");
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].payload.policy.minimum_age_hours, 48);
  assert.equal(postCalls[0].payload.artifact.repo_key, "npm-remote");
  assert.equal(postCalls[0].payload.original_artifact.repo_key, "npm-virtual");
  assert.equal(postCalls[0].options.timeout, 2500);
  assert.equal(postCalls[0].options.headers.Authorization, "Bearer test-token");
});

test("block decision stops in enforce mode", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const blockResponse = await readJson("test/fixtures/block-response.json");
  const { context } = makeContext({ response: blockResponse, mode: "enforce" });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.equal(ageGateHeader(result), "block");
  assert.match(result.message, /blocked npm:@scope\/pkg@1\.2\.3/);
});

test("block decision warns in audit mode", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const blockResponse = await readJson("test/fixtures/block-response.json");
  const { context } = makeContext({ response: blockResponse, mode: "audit" });

  const result = await worker(context, event);

  assert.equal(result.status, "WARN");
  assert.equal(ageGateHeader(result), "would-block");
  assert.match(result.message, /AUDIT ONLY/);
});

test("warn decision returns WARN", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const { context } = makeContext({
    response: {
      decision: "warn",
      reason: "Could not determine publish time for this artifact."
    }
  });

  const result = await worker(context, event);

  assert.equal(result.status, "WARN");
  assert.equal(ageGateHeader(result), "warn");
});

test("API error stops in enforce mode", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const { context } = makeContext({
    error: Object.assign(new Error("connect timeout"), { response: { status: 503 } }),
    mode: "enforce"
  });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.equal(ageGateHeader(result), "api-error-block");
  assert.match(result.message, /status=503/);
});

test("API error warns in audit mode", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const { context } = makeContext({
    error: new Error("connect timeout"),
    mode: "audit"
  });

  const result = await worker(context, event);

  assert.equal(result.status, "WARN");
  assert.equal(ageGateHeader(result), "api-error-audit");
  assert.match(result.message, /Would fail closed in enforce mode/);
});

test("missing repoPath stops without calling API", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const { context, postCalls } = makeContext({
    response: await readJson("test/fixtures/allow-response.json")
  });
  delete event.metadata.repoPath;

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.equal(postCalls.length, 0);
  assert.match(result.message, /missing repoPath metadata/);
});

test("missing required secrets stops without calling API", async () => {
  const worker = await loadWorker();
  const event = await readJson("test/fixtures/before-remote-download-event.json");
  const { context, postCalls } = makeContext({ url: "", token: "" });

  const result = await worker(context, event);

  assert.equal(result.status, "STOP");
  assert.equal(postCalls.length, 0);
  assert.match(result.message, /missing PACKAGE_AGE_GATE_URL or PACKAGE_AGE_GATE_TOKEN/);
});

for (const field of ["headOnly", "checksum", "metadata"]) {
  test(`${field} request proceeds without calling API`, async () => {
    const worker = await loadWorker();
    const event = clone(await readJson("test/fixtures/before-remote-download-event.json"));
    const { context, postCalls } = makeContext({
      response: await readJson("test/fixtures/block-response.json")
    });
    event.metadata[field] = true;

    const result = await worker(context, event);

    assert.equal(result.status, "PROCEED");
    assert.equal(postCalls.length, 0);
    assert.equal(ageGateHeader(result), "skipped-non-content-request");
  });
}
