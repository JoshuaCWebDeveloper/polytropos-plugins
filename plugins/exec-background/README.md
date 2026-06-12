# Exec Background

Adds `background: boolean` to the outer OpenClaw-provided `exec_command`
adapter. When true, the `before_tool_call` hook consumes the parameter and
rewrites the command to:

- create a per-launch log file;
- start `/usr/bin/sh` under `/usr/bin/nohup` and `/usr/bin/setsid`;
- detach stdin from `/dev/null`;
- append stdout and stderr to the log;
- return the detached PID and log path through the normal exec result.

All unrelated exec parameters are preserved. The original command still runs
under the downstream tool's working directory, environment, sandbox, and
approval behavior.

This plugin deliberately does not intercept OpenClaw's standard `exec` tool.
Both the repository-pinned OpenClaw 2026.5.2 and installed OpenClaw 2026.6.1
already define `background` in the `exec` schema and return a managed process
session that can be controlled with the `process` tool. Rewriting that path to
`nohup`/`setsid` would regress process polling, input, termination, timeout, and
exit-notification behavior.

## Core schema contract

The plugin expects this additive core API:

```ts
api.registerToolSchemaContribution({
  toolName: "exec_command",
  properties: {
    background: {
      type: "boolean",
      default: false,
      description: "..."
    }
  }
});
```

Contributions must merge into the named tool's top-level object schema before
provider projection and validation. Core remains the owner of the tool and its
required fields. Duplicate property contributions should be rejected unless
they are structurally identical.

OpenClaw 2026.6.1 does not yet expose this registrar to external plugins. The
runtime hook is installed regardless, but first-class model-visible use requires
that core seam.

The Codex app-server approval relay is not part of this plugin's runtime path.
Managed Codex agents and their native command approvals are separate from the
outer OpenClaw-owned `functions.exec_command` tool.
