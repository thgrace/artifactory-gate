import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendEntry,
  applyAllowlistEntry,
  serializeAllowlist,
  DuplicateEntryError
} from "../scripts/apply-allowlist-entry.mjs";

const entryA = {
  system: "npm",
  name: "@scope/pkg",
  version: "1.2.3",
  reason: "r",
  addedBy: "dev"
};

test("appendEntry appends to an empty allowlist", () => {
  const next = appendEntry(entryA, []);
  assert.equal(next.length, 1);
  assert.deepEqual(next[0], entryA);
});

test("appendEntry rejects an exact duplicate label", () => {
  assert.throws(() => appendEntry(entryA, [entryA]), DuplicateEntryError);
});

test("appendEntry dedupes pypi by normalized label", () => {
  const existing = {
    system: "pypi",
    name: "flask-foo",
    version: "1.0.0",
    reason: "r",
    addedBy: "dev"
  };
  // Same normalized label (Flask_Foo -> flask-foo) must be treated as duplicate.
  const incoming = { ...existing, name: "Flask_Foo" };
  assert.throws(() => appendEntry(incoming, [existing]), DuplicateEntryError);
});

test("appendEntry allows a different version of the same package", () => {
  const next = appendEntry({ ...entryA, version: "9.9.9" }, [entryA]);
  assert.equal(next.length, 2);
});

test("serializeAllowlist matches the repo's stable shape (2-space, trailing newline)", () => {
  assert.equal(serializeAllowlist([]), "[]\n");
  const out = serializeAllowlist([entryA]);
  assert.ok(out.endsWith("\n"));
  assert.equal(JSON.stringify(JSON.parse(out)), JSON.stringify([entryA]));
  // Confirm 2-space indentation is used (array element nested at 4 spaces).
  assert.match(out, /\n {4}"system": "npm"/);
});

test("applyAllowlistEntry writes back to a temp file and preserves shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowlist-"));
  const path = join(dir, "allowlist.json");
  await writeFile(path, "[]\n");

  const { label, count } = await applyAllowlistEntry(entryA, { path });
  assert.equal(label, "npm:@scope/pkg@1.2.3");
  assert.equal(count, 1);

  const written = await readFile(path, "utf8");
  assert.ok(written.endsWith("\n"));
  assert.deepEqual(JSON.parse(written), [entryA]);
});

test("applyAllowlistEntry rejects a duplicate against the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "allowlist-"));
  const path = join(dir, "allowlist.json");
  await writeFile(path, serializeAllowlist([entryA]));

  await assert.rejects(() => applyAllowlistEntry(entryA, { path }), DuplicateEntryError);
});
