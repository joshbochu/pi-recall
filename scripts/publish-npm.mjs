// Publish the package in cwd using OIDC trusted publishing, or NPM_TOKEN when set.
// An empty NODE_AUTH_TOKEN (from a missing secret) blocks OIDC, so clear it and any
// setup-node auth stub unless a real token is available.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const token = process.env.NPM_TOKEN?.trim() || "";
const npmrcPath = process.env.NPM_CONFIG_USERCONFIG;

if (token) {
  process.env.NODE_AUTH_TOKEN = token;
  console.log("publish-npm: using NPM_TOKEN");
} else {
  delete process.env.NODE_AUTH_TOKEN;
  if (npmrcPath && existsSync(npmrcPath)) {
    const cleaned = readFileSync(npmrcPath, "utf8")
      .split("\n")
      .filter((line) => !line.includes("_authToken"))
      .join("\n");
    writeFileSync(npmrcPath, cleaned);
  }
  console.log("publish-npm: using OIDC trusted publishing");
}

const result = spawnSync("npm", ["publish", "--access", "public"], {
  stdio: "inherit",
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
