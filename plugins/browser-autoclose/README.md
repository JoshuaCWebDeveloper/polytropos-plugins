# browser-autoclose (DEPRECATED)

This plugin is **deprecated**.

## Why

The implementation relies on OpenClaw CLI subcommands/flags that are **not stable** across releases (e.g. it attempted to call:

- `openclaw browser profiles --json --timeout ...`

On the currently installed OpenClaw build in our environment, `openclaw browser profiles` does **not** support `--json`, which caused the plugin's guard loop to spam errors in gateway logs.

## Status

- Do **not** enable this plugin in production.
- It is kept in the repo only as historical reference.

## Replacement

If we still want this behavior, we should replace it with one of:

1) a plugin that uses the internal browser subsystem APIs directly (no CLI shell-outs), or
2) a plugin that feature-detects CLI capabilities and degrades gracefully, or
3) implement browser lifecycle controls as part of the `browser_cloud` tool provider itself.
