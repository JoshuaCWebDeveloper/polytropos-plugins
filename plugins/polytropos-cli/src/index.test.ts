import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import {
  createHooksRelayDaemon,
  createPolytroposCliPlugin,
  runPolytroposHooksRelayCli,
} from "./index.js";

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

test("registers the daemon service and gateway method in full mode", async () => {
  const calls: Array<Record<string, unknown>> = [];
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
    logger: {},
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

  const exitCode = await runPolytroposHooksRelayCli(
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

  assert.equal(exitCode, 5);
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
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdin.end(JSON.stringify({ hook_event_name: "PreToolUse" }));
  let stdoutText = "";
  stdout.on("data", (chunk) => {
    stdoutText += String(chunk);
  });

  const exitCode = await runPolytroposHooksRelayCli(
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

  assert.equal(exitCode, 6);
  assert.equal(stdoutText, "fallback-out");
  assert.deepEqual(gatewayCalls, ["polytropos.hooksRelay.invoke", "nativeHook.invoke"]);
});
