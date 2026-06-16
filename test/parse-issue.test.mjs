import assert from "node:assert/strict";
import test from "node:test";
import { parseIssueBody, IssueValidationError } from "../scripts/parse-issue.mjs";

// A realistic rendered Issue Form body: each field is a `### <Label>` heading
// followed by its value. Blank optional fields render as `_No response_`.
function renderBody({ system, name, version, reason }) {
  const part = (label, value) => `### ${label}\n\n${value}\n`;
  return [
    part("System", system),
    part("Name", name),
    part("Version", version),
    part("Reason", reason)
  ].join("\n");
}

test("valid npm body parses to the correct entry (name verbatim)", () => {
  const body = renderBody({
    system: "npm",
    name: "@scope/pkg",
    version: "1.2.3",
    reason: "Approved exception — TICKET-123"
  });

  const entry = parseIssueBody(body, "octocat");

  assert.deepEqual(entry, {
    system: "npm",
    name: "@scope/pkg",
    version: "1.2.3",
    reason: "Approved exception — TICKET-123",
    addedBy: "octocat"
  });
});

test("pypi name is PEP 503 normalized", () => {
  const body = renderBody({
    system: "pypi",
    name: "Flask_Foo",
    version: "1.0.0",
    reason: "needed for build"
  });

  const entry = parseIssueBody(body, "dev");

  assert.equal(entry.name, "flask-foo");
  assert.equal(entry.system, "pypi");
});

test("system value is lowercased and validated", () => {
  const body = renderBody({
    system: "NPM",
    name: "left-pad",
    version: "1.0.0",
    reason: "x"
  });
  assert.equal(parseIssueBody(body, "dev").system, "npm");
});

test("unsupported system throws", () => {
  const body = renderBody({
    system: "maven",
    name: "junit",
    version: "4.13",
    reason: "x"
  });
  assert.throws(() => parseIssueBody(body, "dev"), IssueValidationError);
});

test("blank required field (_No response_) throws", () => {
  const body = renderBody({
    system: "npm",
    name: "_No response_",
    version: "1.0.0",
    reason: "x"
  });
  assert.throws(() => parseIssueBody(body, "dev"), /Name.*blank/);
});

test("missing section throws", () => {
  const body = "### System\n\nnpm\n\n### Name\n\nleft-pad\n";
  assert.throws(() => parseIssueBody(body, "dev"), /Version/);
});

test("empty author throws", () => {
  const body = renderBody({
    system: "npm",
    name: "left-pad",
    version: "1.0.0",
    reason: "x"
  });
  assert.throws(() => parseIssueBody(body, ""), /author/);
});

test("non-string body throws", () => {
  assert.throws(() => parseIssueBody(null, "dev"), IssueValidationError);
});

test("multi-line reason is preserved and trimmed", () => {
  const body = renderBody({
    system: "npm",
    name: "left-pad",
    version: "1.0.0",
    reason: "line one\nline two"
  });
  assert.equal(parseIssueBody(body, "dev").reason, "line one\nline two");
});
