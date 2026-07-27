// postinstall: use the prebuilt addon for this platform when npm installed one,
// otherwise build from source. Building needs Rust, so say so plainly when it is
// missing instead of failing inside cargo.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

function nativeTarget() {
  const { platform, arch } = process;
  if (platform === "win32") return `win32-${arch}-msvc`;
  if (platform === "linux") {
    const report = process.report?.getReport?.();
    const libc = report?.header?.glibcVersionRuntime ? "gnu" : "musl";
    return `linux-${arch}-${libc}`;
  }
  return `${platform}-${arch}`;
}

const target = nativeTarget();
const prebuilt = `@joshbochu/pi-recall-native-${target}`;

try {
  require.resolve(prebuilt);
  console.log(`pi-recall: using prebuilt addon ${prebuilt}`);
  process.exit(0);
} catch {
  // No prebuilt for this platform, or installed with --no-optional.
}

if (existsSync(join(root, "native", "pi-recall-native-v2.node"))) {
  console.log("pi-recall: native addon already built");
  process.exit(0);
}

const cargo = spawnSync("cargo", ["--version"], { stdio: "ignore" });
if (cargo.error || cargo.status !== 0) {
  console.error(
    [
      `pi-recall: no prebuilt addon for ${target} and cargo is not on PATH.`,
      "Install Rust (https://rustup.rs) and reinstall, or install on a platform with a",
      "published prebuilt package.",
    ].join("\n"),
  );
  process.exit(1);
}

const build = spawnSync(process.execPath, [join(root, "scripts", "build-native.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (build.error) throw build.error;
process.exit(build.status ?? 1);
