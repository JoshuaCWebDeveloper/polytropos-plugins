import assert from "node:assert/strict";
import test from "node:test";

import execBackgroundPlugin from "./index.js";

test("registers schema contributions and rewrites enabled exec calls", () => {
  const contributions: unknown[] = [];
  let hook:
    | ((event: { toolName?: string; params?: Record<string, unknown> }) => unknown)
    | undefined;

  execBackgroundPlugin({
    pluginConfig: { logDirectory: "/tmp/exec-background-test" },
    logger: {},
    registerToolSchemaContribution: (contribution) => contributions.push(contribution),
    on: (_name, handler) => {
      hook = handler;
    },
  });

  assert.equal(contributions.length, 1);
  assert.ok(hook);
  const result = hook({
    toolName: "exec_command",
    params: { command: "sleep 5", background: true, yield_time_ms: 100 },
  }) as { params: Record<string, unknown> };
  assert.equal(result.params.background, undefined);
  assert.equal(result.params.yield_time_ms, 100);
  assert.match(String(result.params.command), /background_pid/);
});

test("the hook neutralizes a conflicting foreground cmd alias", () => {
  let hook:
    | ((event: { toolName?: string; params?: Record<string, unknown> }) => unknown)
    | undefined;

  execBackgroundPlugin({
    logger: {},
    on: (_name, handler) => {
      hook = handler;
    },
  });

  assert.ok(hook);
  const result = hook({
    toolName: "functions.exec_command",
    params: {
      command: "printf selected",
      cmd: "printf stale",
      background: true,
    },
  }) as { params: Record<string, unknown> };
  assert.equal(result.params.command, result.params.cmd);
  assert.doesNotMatch(String(result.params.cmd), /printf stale/);
});

test("does not replace OpenClaw exec's native managed background sessions", () => {
  let hook:
    | ((event: { toolName?: string; params?: Record<string, unknown> }) => unknown)
    | undefined;

  execBackgroundPlugin({
    logger: {},
    on: (_name, handler) => {
      hook = handler;
    },
  });

  assert.ok(hook);
  assert.equal(
    hook({
      toolName: "exec",
      params: { command: "sleep 5", background: true },
    }),
    undefined,
  );
});

test("warns but still installs the hook when the core schema seam is absent", () => {
  const warnings: string[] = [];
  let registered = false;

  execBackgroundPlugin({
    logger: { warn: (message) => warnings.push(message) },
    on: () => {
      registered = true;
    },
  });

  assert.equal(registered, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /registerToolSchemaContribution/);
});
