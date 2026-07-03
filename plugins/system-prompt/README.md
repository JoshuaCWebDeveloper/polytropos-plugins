# System Prompt

`system-prompt` mirrors OpenClaw developer instructions into a
Codex prompt. It is intended for app-server deployments where Codex should use
the same instruction text from the app-server Codex home and active prompt build.

At runtime the plugin:

- registers a startup service that reads the plugin-owned
  `openclaw-developer-instructions.md` file, generates the prompt file, and
  reconciles `CODEX_HOME/config.toml`;
- registers an early `before_prompt_build` hook with high
  priority when the OpenClaw runtime accepts `api.on` options;
- reads the current `systemPrompt` from that hook event only for live prompt
  replacement;
- writes the resolved startup developer instructions verbatim as the generated
  prompt file without adding any header or prefix;
- stores the startup-rendered developer instructions in a small cache file for
  diagnostics/inspection, not as the next startup source of truth;
- updates `CODEX_HOME/config.toml` so `model_instructions_file` points at that
  generated prompt file;
- returns `systemPrompt` from the hook only when the incoming prompt is the
  standard OpenClaw Codex developer-instructions envelope, so cron, heartbeat,
  and custom/special prompts are left unchanged.

## Configuration

```toml
[plugins.system-prompt.config]
enabled = true
codexHome = "/home/ec2-user/.codex"
promptFile = "openclaw-app-server-instructions.md"
instructionsCacheFile = ".openclaw-app-server-developer-instructions.md"
startupDeveloperInstructionsFile = "/path/to/openclaw-developer-instructions.md"
hookPriority = 10000
debugHook = false
```

`codexHome` defaults to `CODEX_HOME` and then to the OpenClaw default agent's
`codex-home`, matching the local stdio app-server default. `promptFile` is
resolved relative to `codexHome` unless it is absolute. The prompt file
contains the resolved startup developer instructions verbatim. The generated
`model_instructions_file` remains reconciled for app-server startup/config
consistency; the active turn is handled by `before_prompt_build` splitting the
incoming standard envelope at `## OpenClaw Workspace Instructions` and
returning `systemPrompt` with the workspace-instructions header and tail.

On startup the plugin resolves the full OpenClaw developer instructions in this
order:

1. `startupDeveloperInstructions`
2. `startupDeveloperInstructionsFile`
3. bundled `openclaw-developer-instructions.md`

The bundled file is intentionally operator-populated. The plugin does not use
`before_prompt_build`, request-system-prompt logs, the cache file, existing
generated prompts, workspace files, or the hook payload as startup
source-of-truth.

This plugin expects an OpenClaw runtime where `before_prompt_build` includes
the current `systemPrompt` string on the hook event. For compatibility with
older snapshots, it also accepts the legacy `developerInstructions` field.

Set `debugHook = true` temporarily to log bounded hook diagnostics: event field
presence, prompt length, workspace-marker index, standard-envelope decision,
and returned replacement length. It does not log prompt contents.

## Development

```sh
pnpm --filter @polytropos/system-prompt test
pnpm --filter @polytropos/system-prompt build
```
