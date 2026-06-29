# Polytropos CLI plugin

`polytropos-cli` is an OpenClaw plugin that overrides the internal `hooks relay`
CLI path so Polytropos can route native hook traffic through a reusable daemon.
It registers a hidden nested CLI command at `hooks relay`, starts a daemon in
full registration mode, and exposes the `polytropos.hooksRelay.invoke` gateway
method for relay calls.

## Scope

This plugin overrides only the hooks relay path. It does not replace other
OpenClaw CLI commands, hook behavior, plugin loading, or core runtime flow.

Current OpenClaw core already supports nested plugin CLI registration through
`parentPath`, which is what this package uses for `hooks relay`. No new core
runtime change is required for this plugin path.

## Build and test

From the repo root, run the scoped Nx targets:

```sh
pnpm nx run polytropos-cli:build
pnpm nx run polytropos-cli:test
```

The package-local equivalents are:

```sh
cd plugins/polytropos-cli
pnpm run build
pnpm run test
```

The build compiles TypeScript and packs the plugin artifact under
`dist/plugins/polytropos-cli`. The test target compiles the test build and runs
the package's Node test files only.

## Deploy

Use the repo deploy targets for this package:

```sh
pnpm nx run polytropos-cli:deploy-dev
pnpm nx run polytropos-cli:deploy-prod
```

`deploy-dev` builds the package and symlinks the packed plugin into the local
OpenClaw extensions directory. `deploy-prod` builds the package and copies the
packed plugin into that directory.

The underlying repo script invocations are:

```sh
node scripts/deploy-plugin.mjs symlink dist/plugins/polytropos-cli polytropos-cli
node scripts/deploy-plugin.mjs copy dist/plugins/polytropos-cli polytropos-cli
```

Run broad repo targets such as `pnpm build`, `pnpm deploy:dev`, or
`pnpm deploy:prod` only when intentionally operating on every plugin in this
repository.
