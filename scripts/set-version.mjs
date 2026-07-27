// Write the publish version into package.json, package-lock.json, and the
// native crate manifest so CI can bump without a prior manual version commit.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSemver } from "./next-version.mjs";

const version = process.argv[2];
if (!version) {
  console.error("usage: node scripts/set-version.mjs <semver>");
  process.exit(1);
}
parseSemver(version);

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const packagePath = join(root, "package.json");
const packageManifest = JSON.parse(await readFile(packagePath, "utf8"));
packageManifest.version = version;
await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`, "utf8");

const lockPath = join(root, "package-lock.json");
const lockfile = JSON.parse(await readFile(lockPath, "utf8"));
lockfile.version = version;
if (lockfile.packages?.[""]) lockfile.packages[""].version = version;
await writeFile(lockPath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");

const cargoPath = join(root, "native", "Cargo.toml");
const cargo = await readFile(cargoPath, "utf8");
const updatedCargo = cargo.replace(/^version = "[^"]+"/mu, `version = "${version}"`);
if (updatedCargo === cargo) throw new Error(`could not update version in ${cargoPath}`);
await writeFile(cargoPath, updatedCargo, "utf8");

console.log(`set package version to ${version}`);
