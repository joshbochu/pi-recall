// Release preflight: the git tag must match the package version, any pinned
// prebuilt addon versions must match it too, and the release workflow matrix
// must cover exactly the platforms in native-targets.mjs. A forgotten platform
// otherwise means users on it silently fall back to compiling from source.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_TARGETS } from "./native-targets.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const workflow = await readFile(join(root, ".github/workflows/publish.yml"), "utf8");
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const problems = [];

if (tag && tag !== `v${manifest.version}`) {
  problems.push(`tag ${tag} does not match package version v${manifest.version}`);
}

for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) {
  if (range !== manifest.version) {
    problems.push(`${name} is pinned to ${range}, expected ${manifest.version}`);
  }
}

const expected = NATIVE_TARGETS.map(({ target }) => target).sort();
const inWorkflow = [...workflow.matchAll(/^\s+- target: (\S+)$/gmu)].map((match) => match[1]).sort();
if (expected.join(",") !== inWorkflow.join(",")) {
  problems.push(`publish.yml builds [${inWorkflow}], native-targets.mjs lists [${expected}]`);
}

if (problems.length > 0) {
  console.error(`Release check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `Release check passed for ${manifest.name}@${manifest.version} (${expected.length} prebuilt targets)`,
);
