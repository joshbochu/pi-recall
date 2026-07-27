# AGENTS.md

## Cursor Cloud specific instructions

`pi-recall` is a Pi *extension* (a TypeScript library plus a Rust N-API addon), not a
standalone application. There is no server or GUI to launch and the `pi` CLI is not
installed here. The core product — full-text session search via the Tantivy engine — is
exercised end-to-end by the vitest suite, which loads the real compiled native module.

### Toolchain (already provisioned in the VM snapshot)

- Node: use `>=22.19.0` (declared engine floor). A **login** shell (`bash -l`, which the
  startup update script uses) auto-activates the nvm default 22.19.0. A non-login shell
  falls back to `/exec-daemon/node` (22.14.0), which is below the engine floor — if you
  open a plain shell and see 22.14.0, run `nvm use default` or start `bash -l`.
- Rust: the default toolchain is `stable` (>=1.85 is required because a transitive
  `time-core` dep uses `edition2024`; the base image's 1.83 is too old). `cargo` resolves
  through the rustup proxy, so no extra activation is needed.

### Build / lint / test / run

Standard scripts are in `package.json`; run them from the repo root:

- `npm run check` — TypeScript type-check (`tsc --noEmit`).
- `npm run check:native` — `cargo check` on `native/`.
- `npm test` — rebuilds the native addon (`pretest`) then runs vitest. This is the
  primary end-to-end validation.
- `npm run build:native` — release Cargo build; emits `native/pi-recall-native-v2.node`.

### Non-obvious caveats

- `npm install` runs `build:native` via `postinstall`, so a full Cargo release build
  happens on install (~1–2 min cold, cached afterward). The compiled `.node` file is
  git-ignored and platform-specific.
- The native addon filename is version-suffixed (`-v2`). When the native ABI/schema
  changes the suffix is bumped so an already-running Pi process keeps its mapped binary
  and `/reload` bypasses Node's native-module cache.
