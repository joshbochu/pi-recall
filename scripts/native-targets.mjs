// Platforms that get a prebuilt addon package. Keys match native-binding.ts's
// nativeTarget(); the release workflow matrix must list exactly these targets,
// which check-release.mjs verifies.
export const NATIVE_TARGETS = [
  { target: "darwin-arm64", cargoTarget: "aarch64-apple-darwin" },
  { target: "darwin-x64", cargoTarget: "x86_64-apple-darwin" },
  { target: "linux-x64-gnu", cargoTarget: "x86_64-unknown-linux-gnu" },
  { target: "linux-arm64-gnu", cargoTarget: "aarch64-unknown-linux-gnu" },
  { target: "win32-x64-msvc", cargoTarget: "x86_64-pc-windows-msvc" },
];

export function prebuiltPackageName(target) {
  return `@joshbochu/pi-recall-native-${target}`;
}
