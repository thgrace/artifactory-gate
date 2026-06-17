// Codegen: assemble the per-ecosystem, import-free Worker files.
//
// Each deployable Worker must stay a single, import-free TypeScript file (see
// CLAUDE.md). This script concatenates the shared spine (workers/src/
// core.template.ts) with one ecosystem's parser + deps.dev system constant
// (workers/src/ecosystems/<system>.ts) into a standalone Worker, rewriting the
// region between the `<generated:ecosystem>` markers. The `<generated:allowlist>`
// region is owned by build-allowlist.mjs; this script preserves whatever is
// already there (so the two generators own disjoint regions and never fight).
// Humans only ever edit the template + fragments, then run `npm run build`.
//
// Usage:
//   node scripts/build-workers.mjs           # rewrite worker files in place
//   node scripts/build-workers.mjs --check    # exit non-zero if any worker drifted

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

export const TEMPLATE = "workers/src/core.template.ts";

// One entry per deployable ecosystem Worker. Adding an ecosystem = adding a
// fragment + an entry here (plus a deploy manifest).
export const ECOSYSTEMS = [
  {
    key: "npm",
    fragment: "workers/src/ecosystems/npm.ts",
    out: "workers/npm-age-gate.before-remote-download.ts"
  },
  {
    key: "pypi",
    fragment: "workers/src/ecosystems/pypi.ts",
    out: "workers/pypi-age-gate.before-remote-download.ts"
  }
];

const ECO_BEGIN = "// <generated:ecosystem>";
const ECO_END = "// </generated:ecosystem>";
const ALLOW_BEGIN = "// <generated:allowlist>";
const ALLOW_END = "// </generated:allowlist>";

function replaceRegion(source, begin, end, block, target) {
  const beginIdx = source.indexOf(begin);
  const endIdx = source.indexOf(end);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(`${target}: missing markers (${begin} ... ${end})`);
  }
  return source.slice(0, beginIdx) + block + source.slice(endIdx + end.length);
}

function extractRegion(source, begin, end) {
  const beginIdx = source.indexOf(begin);
  const endIdx = source.indexOf(end);
  if (beginIdx === -1 || endIdx === -1) return undefined;
  return source.slice(beginIdx, endIdx + end.length);
}

function renderEcosystemBlock(key, fragmentBody) {
  const header =
    `${ECO_BEGIN} — DO NOT EDIT BY HAND. Source: workers/src/ecosystems/${key}.ts.\n` +
    `// Regenerate with: npm run build:workers\n`;
  return `${header}${fragmentBody.trim()}\n${ECO_END}`;
}

// Assemble one ecosystem's standalone Worker source. The allowlist region is
// preserved from the existing output file (build-allowlist.mjs owns it); on
// first creation the template's empty default is kept.
async function assemble(eco) {
  const template = await readFile(resolve(rootDir, TEMPLATE), "utf8");
  const fragmentBody = await readFile(resolve(rootDir, eco.fragment), "utf8");
  let candidate = replaceRegion(
    template,
    ECO_BEGIN,
    ECO_END,
    renderEcosystemBlock(eco.key, fragmentBody),
    eco.out
  );

  let existing;
  try {
    existing = await readFile(resolve(rootDir, eco.out), "utf8");
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    const allowBlock = extractRegion(existing, ALLOW_BEGIN, ALLOW_END);
    if (allowBlock) {
      candidate = replaceRegion(candidate, ALLOW_BEGIN, ALLOW_END, allowBlock, eco.out);
    }
  }
  return candidate;
}

// Returns the list of ecosystem outputs whose generated source is out of sync.
export async function checkWorkerTargets() {
  const outOfSync = [];
  for (const eco of ECOSYSTEMS) {
    const next = await assemble(eco);
    let existing;
    try {
      existing = await readFile(resolve(rootDir, eco.out), "utf8");
    } catch {
      existing = undefined;
    }
    if (next !== existing) outOfSync.push(eco.out);
  }
  return outOfSync;
}

async function build({ check }) {
  const drifted = [];
  for (const eco of ECOSYSTEMS) {
    const path = resolve(rootDir, eco.out);
    const next = await assemble(eco);
    let existing;
    try {
      existing = await readFile(path, "utf8");
    } catch {
      existing = undefined;
    }
    if (next === existing) continue;
    if (check) {
      drifted.push(eco.out);
    } else {
      await writeFile(path, next);
      console.log(`updated: ${eco.out}`);
    }
  }
  if (check) {
    if (drifted.length) {
      for (const target of drifted) console.error(`out of sync: ${target}`);
      console.error("worker drift: run `npm run build:workers`");
      exit(1);
    }
    console.log("workers in sync");
  } else {
    console.log("worker build complete");
  }
}

const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(argv[1] || "");
if (isMain) {
  build({ check: argv.includes("--check") }).catch((error) => {
    console.error(error.message);
    exit(1);
  });
}
