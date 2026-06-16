// Pure parser for the "Allowlist request" GitHub Issue Form.
//
// GitHub Issue Forms render a submitted issue body deterministically: each form
// field becomes a level-3 heading (`### <Label>`) followed by the field value on
// the lines below it, up to the next heading. An empty optional field renders as
// the literal `_No response_`. This module turns that body (plus the issue author
// login) into an allowlist entry `{ system, name, version, reason, addedBy }`,
// or throws a clear validation error.
//
// This module is intentionally network-free and side-effect-free so it can be
// unit tested directly. deps.dev existence checks live in the workflow, not here.

import { entryLabel, normalizePyPiName } from "./build-allowlist.mjs";

// Maps the issue form field labels (the `### <Label>` headings GitHub renders)
// to the entry keys we extract. Keep in sync with
// .github/ISSUE_TEMPLATE/allowlist-request.yml.
const FIELD_HEADINGS = {
  System: "system",
  Name: "name",
  Version: "version",
  Reason: "reason"
};

// GitHub's placeholder for a left-blank field.
const NO_RESPONSE = "_No response_";

export class IssueValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "IssueValidationError";
  }
}

// Split the rendered issue body into { heading -> value } by scanning for
// `### <heading>` lines and collecting the text in between.
function sectionsFromBody(body) {
  if (typeof body !== "string") {
    throw new IssueValidationError("issue body must be a string");
  }
  const lines = body.split(/\r?\n/);
  const sections = {};
  let current = null;
  let buffer = [];

  const flush = () => {
    if (current !== null) {
      sections[current] = buffer.join("\n").trim();
    }
  };

  for (const line of lines) {
    const match = /^###\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      current = match[1].trim();
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function requireValue(sections, heading) {
  if (!(heading in sections)) {
    throw new IssueValidationError(`missing "${heading}" section in issue body`);
  }
  const value = sections[heading];
  if (value === "" || value === NO_RESPONSE) {
    throw new IssueValidationError(`"${heading}" must not be blank`);
  }
  return value;
}

/**
 * Parse a rendered allowlist-request issue body into an allowlist entry.
 *
 * @param {string} body - the rendered issue body (GitHub Issue Form output).
 * @param {string} author - the issue author login (used for `addedBy`).
 * @returns {{system: string, name: string, version: string, reason: string, addedBy: string}}
 * @throws {IssueValidationError} on any shape/validation problem.
 */
export function parseIssueBody(body, author) {
  if (typeof author !== "string" || author.trim() === "") {
    throw new IssueValidationError("issue author login is required");
  }

  const sections = sectionsFromBody(body);

  const system = requireValue(sections, "System").toLowerCase();
  if (system !== "npm" && system !== "pypi") {
    throw new IssueValidationError(
      `system must be "npm" or "pypi", got "${requireValue(sections, "System")}"`
    );
  }

  // npm names are kept verbatim; PyPI names are PEP 503 normalized so the entry
  // matches the label the Worker builds at runtime. Reuse the shared normalizer.
  const rawName = requireValue(sections, "Name");
  const name = system === "pypi" ? normalizePyPiName(rawName) : rawName;

  const version = requireValue(sections, "Version");
  const reason = requireValue(sections, "Reason");

  const entry = {
    system,
    name,
    version,
    reason,
    addedBy: author.trim()
  };

  // Final guard: entryLabel applies the same shape checks the codegen enforces,
  // so a parsed entry that survives here is guaranteed to be buildable.
  entryLabel(entry, 0);

  return entry;
}
