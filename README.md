# polytropos-plugins

Nx + pnpm monorepo for Polytropos plugins.

## Quickstart
```bash
pnpm install
pnpm nx run hello-plugin:build
pnpm nx run hello-plugin:deploy-dev
```

## Plugin contract (OpenClaw/Polytropos)

This repo builds “external” extensions that OpenClaw loads from `~/.openclaw/extensions/<id>`.

**Minimum shape**

- `openclaw.plugin.json` at the plugin root (this repo authors it at `plugins/<id>/openclaw.plugin.json`)
- `entry` points at the built JS entry module (typically `dist/index.js`)
- Build/packaging produces `dist/plugins/<id>/dist/openclaw.plugin.json` and `dist/plugins/<id>/dist/<entry>`

The build scripts treat the directory containing `openclaw.plugin.json` as the plugin root (the directory OpenClaw is pointed at). See `scripts/pack-plugin.mjs` and `scripts/deploy-plugin.mjs`.

## Hook-only plugins: explicit capability registration

Hook assets can live under a plugin-local `hooks/` directory (e.g. `plugins/<id>/hooks/...`) and are copied into the packaged artifact, but **hooks are not automatically activated just because the folder exists**.

Hook-only plugins must explicitly opt in at runtime by registering their hooks capability from the JS entry module, for example:

- Export a plugin entry (default export) with a `register(api)` function.
- In `register(api)`, call the hook registrar (e.g. `registerPluginHooksFromDir(api, "./hooks")`) so OpenClaw knows this plugin provides hooks.

Example: `plugins/sanitize-guard/src/index.ts` registers hooks from `./hooks`.

## Deploy targets
- `deploy-dev`: symlink `dist/plugins/<name>` → `~/.openclaw/extensions/<name>`
- `deploy-prod`: copy `dist/plugins/<name>` → `~/.openclaw/extensions/<name>`
