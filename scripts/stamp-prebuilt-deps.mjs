// Add the prebuilt addon packages to optionalDependencies, pinned to this
// version, immediately before `npm publish`.
//
// They are deliberately not committed: a lock file cannot reference a version
// that is not published yet, so committing them breaks `npm ci`. The release
// workflow publishes the platform packages first, then stamps and publishes the
// root package, so the tarball on npm always points at addons that exist.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_TARGETS, prebuiltPackageName } from "./native-targets.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

manifest.optionalDependencies = Object.fromEntries(
  NATIVE_TARGETS.map(({ target }) => [prebuiltPackageName(target), manifest.version]),
);

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  `stamped ${NATIVE_TARGETS.length} prebuilt addon dependencies at ${manifest.version}`,
);
