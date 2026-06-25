const SYSTEM = "pypi";

// PEP 503 normalization: lowercase and collapse runs of -, _, . to a single -.
function normalizePyPiName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

// PyPI remote layouts: wheels (<name>-<version>-...whl) and sdists
// (<name>-<version>.tar.gz | .tar.bz2 | .zip).
function parse(path: string): { name: string; version: string } | undefined {
  const filename = path.slice(path.lastIndexOf("/") + 1);

  if (filename.endsWith(".whl")) {
    const parts = filename.slice(0, -4).split("-");
    if (parts.length < 2) return undefined;
    return { name: normalizePyPiName(parts[0]), version: parts[1] };
  }

  const sdistExts = [".tar.gz", ".tar.bz2", ".zip"];
  const ext = sdistExts.find((candidate) => filename.endsWith(candidate));
  if (!ext) return undefined;

  const stem = filename.slice(0, -ext.length);
  const splitIndex = stem.lastIndexOf("-");
  if (splitIndex <= 0) return undefined;

  const name = stem.slice(0, splitIndex);
  const version = stem.slice(splitIndex + 1);
  if (!name || !version) return undefined;
  return { name: normalizePyPiName(name), version };
}
