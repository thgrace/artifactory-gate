// Codegen: inline allowlist.json into the import-free Worker files.
//
// The runtime Worker must stay a single, import-free TypeScript file (see
// CLAUDE.md), so it cannot read allowlist.json at runtime. This script reads the
// JSON source of truth, derives one `system:name@version` match label per entry,
// and rewrites the region between the `<generated:allowlist>` markers in each
// target Worker. Humans only ever edit allowlist.json.
//
// Usage:
//   node scripts/build-allowlist.mjs           # rewrite targets in place
//   node scripts/build-allowlist.mjs --check    # exit non-zero if any target drifted

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

export const ALLOWLIST_PATH = "allowlist.json";

// The runtime Worker carries the generated allowlist block.
export const TARGETS = [
  "workers/package-age-gate.before-remote-download.ts"
];

const BEGIN = "// <generated:allowlist>";
const END = "// </generated:allowlist>";

// Must stay byte-for-byte identical to normalizePyPiName in the Worker so the
// generated label matches the label the Worker builds from parsed.name. PyPI
// names are PEP 503 normalized (lowercase, runs of -, _, . collapsed to -); npm
// names are kept verbatim.
export function normalizePyPiName(name) {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

export function entryLabel(entry, index) {
  const system = entry?.system;
  if (system !== "npm" && system !== "pypi") {
    throw new Error(
      `allowlist[${index}]: system must be "npm" or "pypi", got ${JSON.stringify(system)}`
    );
  }
  const name = entry?.name;
  const version = entry?.version;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`allowlist[${index}]: name must be a non-empty string`);
  }
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`allowlist[${index}]: version must be a non-empty string`);
  }
  const matchName = system === "pypi" ? normalizePyPiName(name) : name;
  return `${system}:${matchName}@${version}`;
}

export function labelsFromAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) {
    throw new Error("allowlist.json must be a JSON array");
  }
  const labels = allowlist.map((entry, index) => entryLabel(entry, index));
  // Dedupe and sort for stable, churn-free output.
  return [...new Set(labels)].sort();
}

export function renderBlock(labels) {
  const header =
    `${BEGIN} — DO NOT EDIT BY HAND. Source: allowlist.json.\n` +
    `// Regenerate with: npm run build:allowlist\n`;
  const setLiteral =
    labels.length === 0
      ? "const ALLOWLIST = new Set([]);"
      : `const ALLOWLIST = new Set([\n${labels
          .map((label) => `  ${JSON.stringify(label)}`)
          .join(",\n")}\n]);`;
  return `${header}${setLiteral}\n${END}`;
}

export function replaceRegion(source, block, target) {
  const beginIdx = source.indexOf(BEGIN);
  const endIdx = source.indexOf(END);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(`${target}: missing allowlist markers (${BEGIN} ... ${END})`);
  }
  return source.slice(0, beginIdx) + block + source.slice(endIdx + END.length);
}

async function readAllowlistBlock() {
  const allowlist = JSON.parse(await readFile(resolve(rootDir, ALLOWLIST_PATH), "utf8"));
  return renderBlock(labelsFromAllowlist(allowlist));
}

// Returns the list of targets whose generated block is out of sync.
export async function checkTargets() {
  const block = await readAllowlistBlock();
  const outOfSync = [];
  for (const target of TARGETS) {
    const source = await readFile(resolve(rootDir, target), "utf8");
    if (replaceRegion(source, block, target) !== source) outOfSync.push(target);
  }
  return outOfSync;
}

async function build({ check }) {
  const block = await readAllowlistBlock();
  const drifted = [];
  for (const target of TARGETS) {
    const path = resolve(rootDir, target);
    const source = await readFile(path, "utf8");
    const next = replaceRegion(source, block, target);
    if (next === source) continue;
    if (check) {
      drifted.push(target);
    } else {
      await writeFile(path, next);
      console.log(`updated: ${target}`);
    }
  }
  if (check) {
    if (drifted.length) {
      for (const target of drifted) console.error(`out of sync: ${target}`);
      console.error("allowlist drift: run `npm run build:allowlist`");
      exit(1);
    }
    console.log("allowlist in sync");
  } else {
    console.log("allowlist build complete");
  }
}

const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(argv[1] || "");
if (isMain) {
  build({ check: argv.includes("--check") }).catch((error) => {
    console.error(error.message);
    exit(1);
  });
}
