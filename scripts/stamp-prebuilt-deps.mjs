// Add the prebuilt addon packages to optionalDependencies, pinned to this
// version, immediately before `npm publish`.
//
// They are deliberately not committed: a lock file cannot reference a version
// that is not published yet, so committing them breaks `npm ci`. The release
// workflow publishes the platform packages first, then stamps and publishes the
// root package, so the tarball on npm always points at addons that exist.
//
// Pass `--published-only` to skip targets that are not yet on the registry at
// this version (first-time OIDC cannot create brand-new package names).
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_TARGETS, prebuiltPackageName } from "./native-targets.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const publishedOnly = process.argv.includes("--published-only");

function isPublished(name, version) {
  try {
    const found = execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return found === version;
  } catch {
    return false;
  }
}

const entries = [];
for (const { target } of NATIVE_TARGETS) {
  const name = prebuiltPackageName(target);
  if (publishedOnly && !isPublished(name, manifest.version)) {
    console.log(`skip ${name}@${manifest.version} (not on npm yet)`);
    continue;
  }
  entries.push([name, manifest.version]);
}

if (entries.length > 0) {
  manifest.optionalDependencies = Object.fromEntries(entries);
} else {
  delete manifest.optionalDependencies;
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  entries.length > 0
    ? `stamped ${entries.length} prebuilt addon dependencies at ${manifest.version}`
    : `no prebuilt addons stamped for ${manifest.version}; install will build from source when needed`,
);
