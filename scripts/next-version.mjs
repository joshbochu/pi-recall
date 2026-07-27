// Choose the next publish version: max(package.json, npm latest), then bump
// patch when that version is already on npm so every main merge can publish.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (!match) throw new Error(`invalid semver: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export function bumpPatch(version) {
  const { major, minor, patch } = parseSemver(version);
  return `${major}.${minor}.${patch + 1}`;
}

export function chooseNextVersion(localVersion, publishedVersion) {
  if (!publishedVersion) return localVersion;
  if (compareSemver(localVersion, publishedVersion) > 0) return localVersion;
  return bumpPatch(publishedVersion);
}

export function readPublishedVersion(name) {
  try {
    return execFileSync("npm", ["view", name, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? "";
    if (stderr.includes("E404") || /404|not found/iu.test(stderr)) return null;
    throw error;
  }
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const published = readPublishedVersion(manifest.name);
  console.log(chooseNextVersion(manifest.version, published));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
