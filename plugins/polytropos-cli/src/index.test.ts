import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { NativeHookRelayCliOptions } from "./index.js";

import cliMetadataPlugin from "./cli-metadata.js";
import {
  createHooksRelayDaemon,
  createPolytroposCliPlugin,
  runPolytroposHooksRelayCli,
} from "./index.js";

test("lightweight CLI metadata claims hooks relay without importing the full plugin entrypoint", () => {
  let cliRegistrar:
    | ((ctx: { program: unknown }) => void | Promise<void>)
    | undefined;
  let cliOptions: Record<string, unknown> | undefined;

  cliMetadataPlugin.register({
    registrationMode: "cli-metadata",
    pluginConfig: {},
    registerCli: (
      registrar: (ctx: { program: unknown }) => void | Promise<void>,
      opts?: Parameters<OpenClawPluginApi["registerCli"]>[1],
    ) => {
      cliRegistrar = registrar;
      cliOptions = opts as Record<string, unknown>;
    },
  } as never);

  assert.ok(cliRegistrar);
  assert.deepEqual(cliOptions?.parentPath, ["hooks"]);
  assert.deepEqual(cliOptions?.commands, ["relay"]);
  assert.deepEqual(cliOptions?.descriptors, [
    {
      name: "relay",
      description: "Internal native harness hook relay",
      hasSubcommands: false,
    },
  ]);
});

test("registers a nested hooks relay CLI override in cli-metadata mode", () => {
  const plugin = createPolytroposCliPlugin();
  let cliRegistrar:
    | ((ctx: { program: unknown }) => void | Promise<void>)
    | undefined;
  let cliOptions: Record<string, unknown> | undefined;

  plugin.register({
    registrationMode: "cli-metadata",
    pluginConfig: {},
    registerCli: (
      registrar: (ctx: { program: unknown }) => void | Promise<void>,
      opts?: Parameters<OpenClawPluginApi["registerCli"]>[1],
    ) => {
      cliRegistrar = registrar;
      cliOptions = opts as Record<string, unknown>;
    },
  } as never);

  assert.ok(cliRegistrar);
  assert.deepEqual(cliOptions?.parentPath, ["hooks"]);
  assert.deepEqual(cliOptions?.commands, ["relay"]);
  assert.deepEqual(cliOptions?.descriptors, [
    {
      name: "relay",
      description: "Internal native harness hook relay",
      hasSubcommands: false,
    },
  ]);
});

test("logs plugin ownership while constructing the hooks relay command", async () => {
  const plugin = createPolytroposCliPlugin({
    argv: ["node", "polytropos.mjs", "hooks", "relay", "--help"],
  });
  let cliRegistrar:
    | ((ctx: { program: unknown }) => void | Promise<void>)
    | undefined;
  const command = {
    command() {
      return this;
    },
    description() {
      return this;
    },
    requiredOption() {
      return this;
    },
    option() {
      return this;
    },
    action() {
      return this;
    },
  };

  plugin.register({
    registrationMode: "cli-metadata",
    pluginConfig: {},
    registerCli: (registrar: (ctx: { program: unknown }) => void | Promise<void>) => {
      cliRegistrar = registrar;
    },
  } as never);

  assert.ok(cliRegistrar);
  const originalConsoleError = console.error;
  const consoleErrors: string[] = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
  try {
    await cliRegistrar({ program: command });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(consoleErrors, [
    "[polytropos-cli] plugin CLI override handling hooks relay",
  ]);
});

test("the CLI override logs when it handles hooks relay", async () => {
  const stdin = new PassThrough();
  stdin.end("{}");
  const plugin = createPolytroposCliPlugin({
    callGatewayFromCli: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    argv: ["node", "polytropos.mjs", "hooks", "relay"],
    stdin,
  });
  let cliRegistrar:
    | ((ctx: { program: unknown }) => void | Promise<void>)
    | undefined;
  let actionHandler: ((opts: NativeHookRelayCliOptions) => Promise<void> | void) | undefined;
  const command = {
    command() {
      return this;
    },
    description() {
      return this;
    },
    requiredOption() {
      return this;
    },
    option() {
      return this;
    },
    action(handler: (opts: NativeHookRelayCliOptions) => Promise<void> | void) {
      actionHandler = handler;
      return this;
    },
  };

  plugin.register({
    registrationMode: "cli-metadata",
    pluginConfig: {},
    registerCli: (registrar: (ctx: { program: unknown }) => void | Promise<void>) => {
      cliRegistrar = registrar;
    },
  } as never);

  assert.ok(cliRegistrar);
  await cliRegistrar({ program: command });
  assert.ok(actionHandler);

  const originalConsoleError = console.error;
  const previousExitCode = process.exitCode;
  const consoleErrors: string[] = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };

  try {
    await actionHandler({
      provider: "codex",
      relayId: "relay-1",
      generation: "generation-1",
      event: "pre_tool_use",
      timeout: "5000",
    });
  } finally {
    console.error = originalConsoleError;
    process.exitCode = previousExitCode;
  }

  assert.equal(consoleErrors[0], "[polytropos-cli] hooks relay validating options");
});

test("logs plugin ownership before rejecting missing required options", async () => {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  stdin.end("{}");
  let stderrText = "";
  stderr.on("data", (chunk) => {
    stderrText += String(chunk);
  });
  const originalConsoleError = console.error;
  const consoleErrors: string[] = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };

  let exitCode: number;
  try {
    exitCode = await runPolytroposHooksRelayCli({}, { stdin, stderr });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(exitCode, 1);
  assert.equal(consoleErrors[0], "[polytropos-cli] hooks relay validating options");
  assert.match(stderrText, /Missing required option --provider/);
});

for (const argv of [
  ["node", "polytropos.mjs", "hooks", "relay", "--help"],
  ["node", "polytropos.mjs", "hooks", "relay", "--provider", "codex"],
]) {
  test(`the CLI override proves ownership before validation for ${argv.slice(4).join(" ")}`, async () => {
    const consoleErrors: string[] = [];
    const originalConsoleError = console.error;
    let actionHandler: ((opts: NativeHookRelayCliOptions) => Promise<void> | void) | undefined;
    let cliRegistrar:
      | ((ctx: { program: unknown }) => void | Promise<void>)
      | undefined;
    const command = {
      command() {
        return this;
      },
      description() {
        return this;
      },
      requiredOption() {
        return this;
      },
      option() {
        return this;
      },
      action(handler: (opts: NativeHookRelayCliOptions) => Promise<void> | void) {
        actionHandler = handler;
        return this;
      },
    };
    const plugin = createPolytroposCliPlugin({ argv });

    plugin.register({
      registrationMode: "cli-metadata",
      pluginConfig: {},
      registerCli: (registrar: (ctx: { program: unknown }) => void | Promise<void>) => {
        cliRegistrar = registrar;
      },
    } as never);

    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(" "));
    };
    try {
      assert.ok(cliRegistrar);
      await cliRegistrar({ program: command });
    } finally {
      console.error = originalConsoleError;
    }

    assert.ok(actionHandler);
    assert.deepEqual(consoleErrors, [
      "[polytropos-cli] plugin CLI override handling hooks relay",
    ]);
  });
}

test("does not log the proof marker while registering unrelated CLI paths", async () => {
  const consoleErrors: string[] = [];
  const originalConsoleError = console.error;
  let cliRegistrar:
    | ((ctx: { program: unknown }) => void | Promise<void>)
    | undefined;
  const command = {
    command() {
      return this;
    },
    description() {
      return this;
    },
    requiredOption() {
      return this;
    },
    option() {
      return this;
    },
    action() {
      return this;
    },
  };
  const plugin = createPolytroposCliPlugin({
    argv: ["node", "polytropos.mjs", "hooks", "list"],
  });

  plugin.register({
    registrationMode: "cli-metadata",
    pluginConfig: {},
    registerCli: (registrar: (ctx: { program: unknown }) => void | Promise<void>) => {
      cliRegistrar = registrar;
    },
  } as never);

  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
  try {
    assert.ok(cliRegistrar);
    await cliRegistrar({ program: command });
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(consoleErrors, []);
});

test("registers the daemon service and gateway method in full mode", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const loggerMessages: string[] = [];
  const plugin = createPolytroposCliPlugin({
    invokeNativeHookRelay: async (params) => {
      calls.push(params as Record<string, unknown>);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
  });
  let service:
    | { start: () => Promise<void> | void; stop: () => Promise<void> | void }
    | undefined;
  let gatewayMethod:
    | ((ctx: {
        params?: Record<string, unknown>;
        respond: (ok: boolean, payload?: unknown) => void;
      }) => Promise<void>)
    | undefined;
  let respondedOk: boolean | undefined;
  let respondedPayload: unknown;

  plugin.register({
    registrationMode: "full",
    pluginConfig: {},
    logger: {
      info: (message: string) => {
        loggerMessages.push(message);
      },
    },
    registerCli: () => {},
    registerService: (nextService: {
      start: () => Promise<void> | void;
      stop?: () => Promise<void> | void;
    }) => {
      service = nextService as typeof service;
    },
    registerGatewayMethod: (
      _name: string,
      handler: (ctx: {
        params?: Record<string, unknown>;
        respond: (ok: boolean, payload?: unknown) => void;
      }) => Promise<void>,
    ) => {
      gatewayMethod = handler as typeof gatewayMethod;
    },
  } as never);

  assert.ok(service);
  assert.ok(gatewayMethod);
  await service.start();
  await gatewayMethod({
    params: {
      provider: "codex",
      relayId: "relay-1",
      generation: "generation-1",
      event: "pre_tool_use",
      rawPayload: { hook_event_name: "PreToolUse" },
    },
    respond: (ok, payload) => {
      respondedOk = ok;
      respondedPayload = payload;
    },
  });

  assert.equal(respondedOk, true);
  assert.deepEqual(respondedPayload, { stdout: "ok", stderr: "", exitCode: 0 });
  assert.deepEqual(calls, [
    {
      provider: "codex",
      relayId: "relay-1",
      generation: "generation-1",
      event: "pre_tool_use",
      rawPayload: { hook_event_name: "PreToolUse" },
      requireGeneration: true,
    },
  ]);
  assert.deepEqual(loggerMessages.slice(1), [
    "[polytropos-cli] gateway polytropos.hooksRelay.invoke invoked",
    "[polytropos-cli] gateway polytropos.hooksRelay.invoke succeeded",
  ]);
  await service.stop();
});

test("the daemon refuses relay traffic before startup", async () => {
  const daemon = createHooksRelayDaemon(
    { logger: {} } as never,
    {
      invokeNativeHookRelay: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    },
  );

  await assert.rejects(
    daemon.invoke({
      provider: "codex",
      relayId: "relay-1",
      generation: "generation-1",
      event: "pre_tool_use",
      rawPayload: {},
    }),
    /not running/,
  );
});

test("wires the daemon transport ahead of the core gateway fallback", async () => {
  const gatewayCalls: Array<{ method: string; params: unknown; timeout?: string }> = [];
  const consoleErrors: string[] = [];
  const originalConsoleError = console.error;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdin.end(JSON.stringify({ hook_event_name: "PreToolUse" }));
  let stdoutText = "";
  let stderrText = "";
  stdout.on("data", (chunk) => {
    stdoutText += String(chunk);
  });
  stderr.on("data", (chunk) => {
    stderrText += String(chunk);
  });

  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };

  let exitCode: number;
  try {
    exitCode = await runPolytroposHooksRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "4321",
      },
      {
        callGatewayFromCli: async (method, opts, params) => {
          gatewayCalls.push({ method, params, timeout: opts.timeout });
          if (method === "polytropos.hooksRelay.invoke") {
            return { stdout: "daemon-out", stderr: "daemon-err", exitCode: 5 };
          }
          return { stdout: "fallback-out", stderr: "fallback-err", exitCode: 6 };
        },
        stdin,
        stdout,
        stderr,
      },
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(exitCode, 5);
  assert.deepEqual(consoleErrors, [
    "[polytropos-cli] hooks relay validating options",
    "[polytropos-cli] hooks relay invoking plugin gateway",
    "[polytropos-cli] hooks relay plugin gateway succeeded",
  ]);
  assert.equal(stdoutText, "daemon-out");
  assert.equal(stderrText, "daemon-err");
  assert.deepEqual(gatewayCalls, [
    {
      method: "polytropos.hooksRelay.invoke",
      params: {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        rawPayload: { hook_event_name: "PreToolUse" },
      },
      timeout: "4321",
    },
  ]);
});

test("falls back to nativeHook.invoke when the reusable daemon is unavailable", async () => {
  const gatewayCalls: string[] = [];
  const consoleErrors: string[] = [];
  const originalConsoleError = console.error;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.end(JSON.stringify({ hook_event_name: "PreToolUse" }));
  let stdoutText = "";
  stdout.on("data", (chunk) => {
    stdoutText += String(chunk);
  });

  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };

  let exitCode: number;
  try {
    exitCode = await runPolytroposHooksRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "1234",
      },
      {
        callGatewayFromCli: async (method) => {
          gatewayCalls.push(method);
          if (method === "polytropos.hooksRelay.invoke") {
            throw new Error("daemon unavailable");
          }
          return { stdout: "fallback-out", stderr: "", exitCode: 6 };
        },
        stdin,
        stdout,
      },
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(exitCode, 6);
  assert.deepEqual(consoleErrors, [
    "[polytropos-cli] hooks relay validating options",
    "[polytropos-cli] hooks relay invoking plugin gateway",
    "[polytropos-cli] hooks relay falling back to nativeHook.invoke",
    "[polytropos-cli] hooks relay nativeHook.invoke succeeded",
  ]);
  assert.equal(stdoutText, "fallback-out");
  assert.deepEqual(gatewayCalls, ["polytropos.hooksRelay.invoke", "nativeHook.invoke"]);
});

test("logs when fallback nativeHook.invoke is unavailable", async () => {
  const consoleErrors: string[] = [];
  const originalConsoleError = console.error;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdin.end(JSON.stringify({ hook_event_name: "PreToolUse" }));
  let stdoutText = "";
  let stderrText = "";
  stdout.on("data", (chunk) => {
    stdoutText += String(chunk);
  });
  stderr.on("data", (chunk) => {
    stderrText += String(chunk);
  });

  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };

  let exitCode: number;
  try {
    exitCode = await runPolytroposHooksRelayCli(
      {
        provider: "codex",
        relayId: "relay-1",
        generation: "generation-1",
        event: "pre_tool_use",
        timeout: "1234",
      },
      {
        callGatewayFromCli: async () => {
          throw new Error("gateway unavailable");
        },
        stdin,
        stdout,
        stderr,
      },
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(exitCode, 0);
  assert.deepEqual(consoleErrors, [
    "[polytropos-cli] hooks relay validating options",
    "[polytropos-cli] hooks relay invoking plugin gateway",
    "[polytropos-cli] hooks relay falling back to nativeHook.invoke",
    "[polytropos-cli] hooks relay nativeHook.invoke unavailable",
  ]);
  assert.match(stderrText, /native hook relay unavailable: gateway unavailable/);
  assert.match(stdoutText, /"permissionDecision":"deny"/);
});
