import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { NativeHookRelayProcessResponse } from "openclaw/plugin-sdk/agent-harness-runtime";

const POLYTROPOS_HOOKS_RELAY_GATEWAY_METHOD = "polytropos.hooksRelay.invoke";
const POLYTROPOS_HOOKS_RELAY_SERVICE_ID = "polytropos-hooks-relay-daemon";
const MAX_NATIVE_HOOK_STDIN_BYTES = 1024 * 1024;

type PluginConfig = {
  enabled?: boolean;
};

export type NativeHookRelayCliOptions = {
  provider?: string;
  relayId?: string;
  generation?: string;
  event?: string;
  preToolUseUnavailable?: string;
  timeout?: string;
};

type CallGatewayFromCli = typeof import("openclaw/plugin-sdk/gateway-runtime").callGatewayFromCli;
type InvokeNativeHookRelay =
  typeof import("openclaw/plugin-sdk/agent-harness-runtime").invokeNativeHookRelay;

type PluginDeps = {
  callGatewayFromCli?: CallGatewayFromCli;
  invokeNativeHookRelay?: InvokeNativeHookRelay;
  argv?: readonly string[];
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
};

type NativeHookRelayGatewayParams = {
  provider?: string;
  relayId?: string;
  generation?: string;
  event?: string;
  rawPayload?: unknown;
};

type CliCommand = {
  command(name: string, opts?: { hidden?: boolean }): CliCommand;
  description(text: string): CliCommand;
  requiredOption(flags: string, description: string): CliCommand;
  option(flags: string, description: string, defaultValue?: string): CliCommand;
  action(handler: (...args: never[]) => void | Promise<void>): CliCommand;
};

type HooksRelayDaemon = {
  id: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
  invoke: (params: NativeHookRelayGatewayParams) => Promise<NativeHookRelayProcessResponse>;
};

function isEnabled(config: PluginConfig | undefined): boolean {
  return config?.enabled !== false;
}

function toGatewayRpcOpts(timeoutMs: number | undefined): { timeout?: string } {
  return timeoutMs !== undefined ? { timeout: String(timeoutMs) } : {};
}

async function loadCallGatewayFromCli(): Promise<CallGatewayFromCli> {
  return (await import("openclaw/plugin-sdk/gateway-runtime")).callGatewayFromCli;
}

async function loadInvokeNativeHookRelay(): Promise<InvokeNativeHookRelay> {
  return (await import("openclaw/plugin-sdk/agent-harness-runtime")).invokeNativeHookRelay;
}

function readRequiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing required option --${name}`);
}

function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return 5_000;
  }
  if (!/^\+?[0-9]+$/u.test(raw)) {
    throw new Error(`Received: ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Received: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

async function readStreamText(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new Error(`native hook input exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function writeText(stream: NodeJS.WritableStream, value: string | undefined): void {
  if (value) {
    stream.write(value);
  }
}

function formatRelayCliError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}\n`;
}

function renderUnavailableResponse(params: {
  event: string;
  message: string;
  preToolUseUnavailable?: string;
}): NativeHookRelayProcessResponse {
  if (params.event === "pre_tool_use") {
    if (params.preToolUseUnavailable === "noop") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: params.message,
        },
      }),
      stderr: "",
      exitCode: 0,
    };
  }

  if (params.event === "permission_request") {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: params.message,
          },
        },
      }),
      stderr: "",
      exitCode: 0,
    };
  }

  return { stdout: "", stderr: "", exitCode: 0 };
}

function createHooksRelayDaemon(
  api: Pick<OpenClawPluginApi, "logger">,
  deps: Pick<PluginDeps, "invokeNativeHookRelay"> = {},
): HooksRelayDaemon {
  let started = false;

  return {
    id: POLYTROPOS_HOOKS_RELAY_SERVICE_ID,
    start() {
      started = true;
      api.logger.info?.("[polytropos-cli] hooks relay daemon ready");
    },
    stop() {
      started = false;
      api.logger.info?.("[polytropos-cli] hooks relay daemon stopped");
    },
    async invoke(params: NativeHookRelayGatewayParams) {
      if (!started) {
        throw new Error("polytropos hooks relay daemon is not running");
      }
      const invokeRelay = deps.invokeNativeHookRelay ?? (await loadInvokeNativeHookRelay());
      return await invokeRelay({
        provider: params.provider,
        relayId: params.relayId,
        generation: params.generation,
        event: params.event,
        rawPayload: params.rawPayload,
        requireGeneration: true,
      });
    },
  };
}

export async function runPolytroposHooksRelayCli(
  opts: NativeHookRelayCliOptions,
  deps: Pick<PluginDeps, "callGatewayFromCli" | "stdin" | "stdout" | "stderr"> = {},
): Promise<number> {
  const callGateway = deps.callGatewayFromCli ?? (await loadCallGatewayFromCli());
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  let timeoutMs: number;
  try {
    timeoutMs = parseTimeoutMs(opts.timeout);
  } catch (error) {
    writeText(stderr, formatRelayCliError("invalid native hook timeout", error));
    return 1;
  }

  let provider: string;
  let relayId: string;
  let event: string;
  try {
    provider = readRequiredOption(opts.provider, "provider");
    relayId = readRequiredOption(opts.relayId, "relay-id");
    event = readRequiredOption(opts.event, "event");
  } catch (error) {
    writeText(stderr, formatRelayCliError("invalid native hook options", error));
    return 1;
  }

  let rawPayload: unknown;
  try {
    const rawInput = await readStreamText(stdin, MAX_NATIVE_HOOK_STDIN_BYTES);
    rawPayload = rawInput.trim() ? JSON.parse(rawInput) : null;
  } catch (error) {
    writeText(stderr, formatRelayCliError("failed to read native hook input", error));
    return 1;
  }

  try {
    const response = (await callGateway(
      POLYTROPOS_HOOKS_RELAY_GATEWAY_METHOD,
      toGatewayRpcOpts(timeoutMs),
      {
        provider,
        relayId,
        generation: opts.generation?.trim() || undefined,
        event,
        rawPayload,
      },
      { scopes: ["operator.admin"] },
    )) as NativeHookRelayProcessResponse;
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    return response.exitCode;
  } catch {
    // Fall through to the core one-shot gateway relay when the reusable daemon
    // is unavailable or the plugin has not been activated yet.
  }

  try {
    const response = (await callGateway(
      "nativeHook.invoke",
      toGatewayRpcOpts(timeoutMs),
      {
        provider,
        relayId,
        generation: opts.generation?.trim() || undefined,
        event,
        rawPayload,
      },
      { scopes: ["operator.admin"] },
    )) as NativeHookRelayProcessResponse;
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    return response.exitCode;
  } catch (error) {
    writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
    const response = renderUnavailableResponse({
      event,
      preToolUseUnavailable: opts.preToolUseUnavailable,
      message: "Native hook relay unavailable",
    });
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    return response.exitCode;
  }
}

export function createPolytroposCliPlugin(deps: PluginDeps = {}) {
  return {
    id: "polytropos-cli",
    name: "Polytropos CLI",
    description: "Overrides hooks relay to route native hook traffic through a reusable daemon.",
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
      },
    },
    register(api: OpenClawPluginApi) {
      if (!isEnabled(api.pluginConfig as PluginConfig | undefined)) {
        return;
      }

      if (
        api.registrationMode === "cli-metadata" ||
        api.registrationMode === "discovery" ||
        api.registrationMode === "full"
      ) {
        api.registerCli(
          ({ program }) => {
            const hooks = program as unknown as CliCommand;
            hooks
              .command("relay", { hidden: true })
              .description("Internal native harness hook relay")
              .requiredOption("--provider <provider>", "Native harness provider")
              .requiredOption("--relay-id <id>", "Native hook relay id")
              .option("--generation <generation>", "Native hook relay registration generation")
              .requiredOption("--event <event>", "Native hook event")
              .option(
                "--pre-tool-use-unavailable <mode>",
                "PreToolUse fallback mode when the originating relay is unavailable",
              )
              .option("--timeout <ms>", "Gateway timeout in ms", "5000")
              .action(async (opts: NativeHookRelayCliOptions) => {
                process.exitCode = await runPolytroposHooksRelayCli(opts, deps);
              });
          },
          {
            parentPath: ["hooks"],
            commands: ["relay"],
            descriptors: [
              {
                name: "relay",
                description: "Internal native harness hook relay",
                hasSubcommands: false,
              },
            ],
          },
        );
      }

      if (api.registrationMode !== "full") {
        return;
      }

      const daemon = createHooksRelayDaemon(api, deps);
      api.registerService(daemon);
      api.registerGatewayMethod(
        POLYTROPOS_HOOKS_RELAY_GATEWAY_METHOD,
        async ({ params, respond }) => {
          api.logger.info?.("[polytropos-cli] gateway polytropos.hooksRelay.invoke invoked");
          const response = await daemon.invoke((params ?? {}) as NativeHookRelayGatewayParams);
          api.logger.info?.("[polytropos-cli] gateway polytropos.hooksRelay.invoke succeeded");
          respond(true, response);
        },
      );
    },
  };
}

export { createHooksRelayDaemon };

export default createPolytroposCliPlugin();
