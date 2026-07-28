import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_TARGETS } from "./native-targets.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const missing = [];

for (const { target } of NATIVE_TARGETS) {
  const path = join(root, "native", "prebuilds", target, "pi-recall-native.node");
  try {
    const file = await stat(path);
    if (!file.isFile() || file.size === 0) missing.push(target);
  } catch {
    missing.push(target);
  }
}

if (missing.length > 0) {
  console.error(`Missing prebuilt addons: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Found all ${NATIVE_TARGETS.length} bundled prebuilt addons`);
