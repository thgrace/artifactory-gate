// Append a validated allowlist entry to allowlist.json.
//
// Reads the JSON source of truth, rejects a duplicate (same `system:name@version`
// match label), appends the new entry, and writes the file back with stable
// 2-space formatting and a trailing newline. This script intentionally does NOT
// run `npm run build:allowlist`; the intake workflow runs that as a separate step
// so the generated Worker block and the JSON are committed together.
//
// Importable (export `applyAllowlistEntry`) and runnable as a CLI:
//
//   node scripts/apply-allowlist-entry.mjs '<entry-json>'
//   echo '<entry-json>' | node scripts/apply-allowlist-entry.mjs

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { argv, exit, stdin } from "node:process";
import { fileURLToPath } from "node:url";
import { ALLOWLIST_PATH, entryLabel } from "./build-allowlist.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

export class DuplicateEntryError extends Error {
  constructor(label) {
    super(`allowlist already contains ${label}`);
    this.name = "DuplicateEntryError";
    this.label = label;
  }
}

// Serialize the allowlist with the repo's stable formatting: 2-space indent and
// a single trailing newline (matches the shipped `[]\n`).
export function serializeAllowlist(allowlist) {
  return `${JSON.stringify(allowlist, null, 2)}\n`;
}

/**
 * Append `entry` to the allowlist array unless a duplicate label is present.
 *
 * @param {object} entry - { system, name, version, reason, addedBy }
 * @param {Array} allowlist - current allowlist array
 * @returns {Array} a new array with `entry` appended
 * @throws {DuplicateEntryError} if the entry's label already exists
 */
export function appendEntry(entry, allowlist) {
  if (!Array.isArray(allowlist)) {
    throw new Error("allowlist.json must be a JSON array");
  }
  const newLabel = entryLabel(entry, allowlist.length);
  const existing = new Set(allowlist.map((e, i) => entryLabel(e, i)));
  if (existing.has(newLabel)) {
    throw new DuplicateEntryError(newLabel);
  }
  return [...allowlist, entry];
}

/**
 * Read allowlist.json, append the entry (rejecting duplicates), and write back.
 *
 * @param {object} entry - the entry to append
 * @param {object} [opts]
 * @param {string} [opts.path] - absolute path to allowlist.json (defaults to repo root)
 * @returns {Promise<{label: string, count: number}>}
 */
export async function applyAllowlistEntry(entry, { path } = {}) {
  const filePath = path ?? resolve(rootDir, ALLOWLIST_PATH);
  const allowlist = JSON.parse(await readFile(filePath, "utf8"));
  const next = appendEntry(entry, allowlist);
  await writeFile(filePath, serializeAllowlist(next));
  return { label: entryLabel(entry, next.length - 1), count: next.length };
}

async function readEntryFromArgsOrStdin() {
  const arg = argv[2];
  if (arg && arg !== "-") return arg;
  // Read JSON entry from stdin.
  let data = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) data += chunk;
  return data;
}

const isMain = resolve(fileURLToPath(import.meta.url)) === resolve(argv[1] || "");
if (isMain) {
  readEntryFromArgsOrStdin()
    .then(async (raw) => {
      if (!raw || raw.trim() === "") {
        throw new Error("no entry JSON provided (pass as arg or via stdin)");
      }
      const entry = JSON.parse(raw);
      const { label, count } = await applyAllowlistEntry(entry);
      console.log(`appended ${label} (allowlist now has ${count} entr${count === 1 ? "y" : "ies"})`);
    })
    .catch((error) => {
      console.error(error.message);
      exit(1);
    });
}
