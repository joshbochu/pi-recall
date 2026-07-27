// Build one platform package from an already-built addon, for the release
// workflow: node scripts/pack-platform.mjs <target> [cargo-target-triple]
//
// Produces npm/<target>/{package.json,pi-recall-native.node} where <target> is
// the napi-rs style key used by native-binding.ts (for example darwin-arm64).
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [target, cargoTarget] = process.argv.slice(2);
if (!target) {
  console.error("usage: node scripts/pack-platform.mjs <target> [cargo-target-triple]");
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const [platform, arch] = target.split("-");

const build = spawnSync(
  "cargo",
  [
    "build",
    "--manifest-path",
    join(root, "native", "Cargo.toml"),
    "--release",
    ...(cargoTarget ? ["--target", cargoTarget] : []),
  ],
  { cwd: root, stdio: "inherit" },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const libraryName =
  platform === "darwin"
    ? "libpi_recall_native.dylib"
    : platform === "win32"
      ? "pi_recall_native.dll"
      : "libpi_recall_native.so";
const releaseDir = cargoTarget
  ? join(root, "native", "target", cargoTarget, "release")
  : join(root, "native", "target", "release");

const packageDir = join(root, "npm", target);
await mkdir(packageDir, { recursive: true });
await copyFile(join(releaseDir, libraryName), join(packageDir, "pi-recall-native.node"));
await writeFile(
  join(packageDir, "package.json"),
  `${JSON.stringify(
    {
      name: `@joshbochu/pi-recall-native-${target}`,
      version: manifest.version,
      description: `Prebuilt pi-recall native addon for ${target}`,
      license: manifest.license,
      repository: manifest.repository,
      main: "pi-recall-native.node",
      files: ["pi-recall-native.node"],
      os: [platform],
      cpu: [arch],
      ...(target.endsWith("-musl") ? { libc: ["musl"] } : {}),
      ...(target.endsWith("-gnu") ? { libc: ["glibc"] } : {}),
      publishConfig: manifest.publishConfig,
      engines: manifest.engines,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`packed npm/${target} for ${manifest.name}@${manifest.version}`);
