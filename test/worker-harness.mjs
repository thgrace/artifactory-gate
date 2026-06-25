// Shared test harness for the per-ecosystem workers. Not a *.test.mjs file, so
// the `node --test test/*.test.mjs` glob does not run it directly.
//
// Each generated worker is a standalone, import-free TypeScript file. This
// harness strips its type annotations by exact string replacement and runs it in
// a node:vm sandbox with mocked ActionStatus + axios. The strip rules are the
// union across both workers; a rule whose string is absent in a given file is a
// harmless no-op. IMPORTANT: if you change a function signature or the default
// export signature in workers/src/core.template.ts or a fragment, update the
// matching .replace(...) call here or the workers fail to load.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(__dirname, "..");
export const DEPS_DEV_BASE = "https://api.deps.dev";

export async function readJson(path) {
  return JSON.parse(await readFile(resolve(rootDir, path), "utf8"));
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function transpileWorkerSource(source) {
  return source
    .replace(
      "function safeString(value: any): string | undefined",
      "function safeString(value)"
    )
    .replace(
      "function normalizePyPiName(name: string): string",
      "function normalizePyPiName(name)"
    )
    .replace(
      "function parse(path: string): { name: string; version: string } | undefined",
      "function parse(path)"
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

export async function loadWorker(workerPath, { allowlist } = {}) {
  let source = await readFile(resolve(rootDir, workerPath), "utf8");
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
      STOP: "STOP"
    }
  });
}

// Build a deps.dev version response whose publishedAt is `ageHours` old.
export function depsDevResponse(ageHours) {
  const publishedMs = Date.now() - ageHours * 3600000;
  return { publishedAt: new Date(publishedMs).toISOString() };
}

export function makeContext({ response, error } = {}) {
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
