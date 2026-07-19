import { spawnSync } from "node:child_process";
import { copyFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeRoot = join(root, "native");
const manifest = join(nativeRoot, "Cargo.toml");
const build = spawnSync("cargo", ["build", "--manifest-path", manifest, "--release"], {
  cwd: root,
  stdio: "inherit",
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const libraryName =
  process.platform === "darwin"
    ? "libpi_recall_native.dylib"
    : process.platform === "win32"
      ? "pi_recall_native.dll"
      : "libpi_recall_native.so";

const source = join(nativeRoot, "target", "release", libraryName);
// Bump the filename when the native ABI/schema changes. A new path avoids Node's
// native-module cache, so Pi can load the new addon during /reload.
const destination = join(nativeRoot, "pi-recall-native-v2.node");
const temporary = `${destination}.${process.pid}.tmp`;
try {
  await copyFile(source, temporary);
  await rename(temporary, destination);
} finally {
  await rm(temporary, { force: true });
}
