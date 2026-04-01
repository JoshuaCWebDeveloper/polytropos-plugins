# polytropos-plugins

Nx + pnpm monorepo for Polytropos plugins.

## Quickstart
```bash
pnpm install
pnpm nx run hello-plugin:build
pnpm nx run hello-plugin:deploy-dev
```

## Deploy targets
- `deploy-dev`: symlink `dist/plugins/<name>` → `~/.openclaw/extensions/<name>`
- `deploy-prod`: copy `dist/plugins/<name>` → `~/.openclaw/extensions/<name>`

