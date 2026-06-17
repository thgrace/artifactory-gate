const SYSTEM = "npm";

// npm remote layout: [@scope/]name/-/<unscoped-name>-<version>.tgz
function parse(path: string): { name: string; version: string } | undefined {
  const marker = "/-/";
  const markerIndex = path.indexOf(marker);
  if (markerIndex === -1) return undefined;

  const name = path.slice(0, markerIndex).replace(/^\/+/, "");
  let filename = path.slice(markerIndex + marker.length);
  if (filename.endsWith(".tgz")) filename = filename.slice(0, -4);
  else if (filename.endsWith(".tar.gz")) filename = filename.slice(0, -7);
  else return undefined;

  const unscoped = name.slice(name.lastIndexOf("/") + 1);
  const prefix = `${unscoped}-`;
  if (!name || !filename.startsWith(prefix)) return undefined;

  const version = filename.slice(prefix.length);
  if (!version) return undefined;
  return { name, version };
}
