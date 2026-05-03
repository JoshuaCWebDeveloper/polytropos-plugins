import { Type } from "@sinclair/typebox";
import { resolveExecSecretRef, type SecretRef } from "./openclaw-secrets-lite.ts";
import { BrowserCloudController } from "./browser-cloud-controller.ts";

// Vendored schema: keep it byte-for-byte compatible with core BrowserToolSchema.
import { BrowserToolSchema } from "./vendor/openclaw/agents-tools-browser-tool.schema.ts";
import { isBrowserCloudFatalError } from "./errors.ts";

type PluginCfg = {
  profileId: string;
  timeoutMin?: number;
  idleStopMs?: number;
  /**
   * What to do with the remote BU session when a tool call throws.
   * - "fatal" (default): stop only on likely-nonrecoverable errors
   * - "always": stop on any error (prevents leaks but can hide endpoint flaps)
   * - "never": never auto-stop (useful for debugging; risk of leaks)
   */
  stopOnError?: "fatal" | "always" | "never";
  apiKey: string | SecretRef;
};

function browserSessionExpiredMessage(): string {
  return "browser session expired — open a new tab with browser_cloud open and take a fresh snapshot before continuing";
}

function isBuSessionExpiredFromStatus(statusJson: any): boolean {
  const diag = statusJson?.diag;
  const bu = diag?.bu;
  if (bu?.ok === true && bu.session) {
    const session = bu.session as Record<string, unknown>;
    const status = String(session.status ?? "").trim().toLowerCase();
    const finishedAt = String(session.finishedAt ?? "").trim();
    if (finishedAt) return true;
    if (["expired", "timed_out", "timed-out", "finished", "stopped", "terminated", "completed", "closed", "dead"].includes(status)) {
      return true;
    }
    return false;
  }
  if (bu?.ok === false) {
    const msg = String(bu.error ?? "").toLowerCase();
    if (msg.includes("http 404") || msg.includes("not found") || msg.includes("invalid or expired")) {
      return true;
    }
  }
  return false;
}

function toBrowserSessionExpiredError(err: unknown): Error {
  const original = err instanceof Error ? err.message : String(err);
  return new Error(`${browserSessionExpiredMessage()}. Original error: ${original}`);
}

function readPluginCfg(api: any): PluginCfg {
  const entry = api?.config?.plugins?.entries?.["browser-cloud"];
  return (entry?.config ?? {}) as PluginCfg;
}

async function resolveApiKey(api: any, cfg: PluginCfg): Promise<string> {
  if (typeof cfg.apiKey === "string") {
    const v = cfg.apiKey.trim();
    if (!v) throw new Error("browser-cloud config apiKey is empty");
    // If user passed a template like ${BROWSER_USE_API_KEY}, treat it as literal.
    // Use SecretRef for exec-based resolution.
    return v;
  }
  const ref = cfg.apiKey as SecretRef;
  if (ref.source !== "exec") {
    throw new Error(`Unsupported apiKey SecretRef source for plugin: ${String(ref.source)}`);
  }
  return await resolveExecSecretRef({ cfg: api.config, ref });
}

let shutdownHandlerInstalled = false;

function isGatewayRuntime(): boolean {
  return (
    process.env.OPENCLAW_SERVICE_KIND === "gateway" ||
    process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" ||
    !!process.env.OPENCLAW_SERVICE_MARKER
  );
}

export default function (api: any) {
  if (!isGatewayRuntime()) return;

  // eslint-disable-next-line no-console
  console.log("[plugins] [browser-cloud] init");

  let controller: BrowserCloudController | null = null;
  let controllerKey: string | null = null;

  const getController = async (): Promise<BrowserCloudController> => {
    const cfg = readPluginCfg(api);
    const apiKey = await resolveApiKey(api, cfg);
    const timeoutMin = cfg.timeoutMin ?? 15;
    const idleStopMs = cfg.idleStopMs ?? 120_000;

    // If config changes, recycle controller to avoid leaks.
    const key = `${cfg.profileId}::${timeoutMin}::${idleStopMs}::${apiKey.slice(0, 6)}`;
    if (controller && controllerKey === key) return controller;

    if (controller) {
      await controller.stop().catch(() => {});
    }

    controller = new BrowserCloudController({
      apiKey,
      profileId: cfg.profileId,
      timeoutMin,
      idleStopMs,
    });
    controllerKey = key;

    if (!shutdownHandlerInstalled) {
      shutdownHandlerInstalled = true;
      const stopOnExit = async () => {
        try {
          await controller?.stop();
        } catch {
          // best-effort
        }
      };
      process.once("beforeExit", () => void stopOnExit());
      process.once("SIGINT", () => void stopOnExit());
      process.once("SIGTERM", () => void stopOnExit());
    }

    return controller;
  };

  // eslint-disable-next-line no-console
  console.log("[plugins] [browser-cloud] registering tool: browser_cloud");

  api.registerTool(
    {
      name: "browser_cloud",
      label: "Browser Cloud",
      /*
      Previous (verbose) tool description (kept for reference):

      description: `
Full-parity browser tool backed by Browser Use Cloud browser sessions (CDP).

Actions: status|start|stop|profiles|tabs|open|focus|close|snapshot|screenshot|navigate|console|pdf|upload|dialog|act.

IMPORTANT:
- All interactions (click/type/press/select/hover/etc) MUST use action='act' with a nested request object.
- To get element refs for interaction, call snapshot with refs set to a STRING enum (not a boolean):
  - refs: 'aria' (preferred)
  - refs: 'role'

Examples:
- Full-page semantic snapshot + refs (recommended default for reading content):
  { action: 'snapshot', refs: 'role', snapshotFormat: 'ai', maxRefs: 120 }
- Interactive-only snapshot (controls/inputs/buttons only, opt-in mode):
  { action: 'snapshot', refs: 'role', snapshotFormat: 'ai', interactive: true, maxRefs: 120 }
  Use this ONLY when you need to find form controls, buttons, and interactive elements—NOT for reading page content.
- Click/type using a ref from the snapshot:
  { action: 'act', request: { kind: 'click', ref: '<ref>' } }
  { action: 'act', request: { kind: 'type', ref: '<ref>', text: '...' } }

NOTE: Most agent workflows should NOT use interactive=true—use the full-page snapshot (no interactive flag) to read page content, forms, results, etc. The interactive flag is only for targeting specific UI controls when you already know what you want to click/type.
`,

      */
      description: `
Full-parity browser tool backed by Browser Use Cloud browser sessions (CDP).

Actions: status|start|stop|profiles|tabs|open|focus|close|snapshot|screenshot|navigate|console|pdf|upload|dialog|act.

IMPORTANT:
- All interactions (click/type/press/select/hover/etc) MUST use action='act' with a nested request object.
- To get element refs for interaction, call snapshot with refs set to a STRING enum (not a boolean):
  - refs: 'aria' (preferred)
  - refs: 'role'
`,

      parameters: BrowserToolSchema as unknown as ReturnType<typeof Type.Object>,
      async execute(_toolCallId: string, args: any) {
        const action = String(args?.action ?? "");

        // Back-compat: ignore target/node fields if passed.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _ignoredTarget = args?.target;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _ignoredNode = args?.node;

        const ctrl = await getController();
        let json: unknown;

        // Mark tool calls as in-flight so idle-timeout can't stop mid-operation.
        (ctrl as any)["sessions"]?.beginAction?.(action);
        try {
          switch (action) {
            case "status":
              json = await ctrl.status();
              break;
            case "start":
              json = await ctrl.start();
              break;
            case "stop":
              json = await ctrl.stop();
              break;
            case "profiles":
              json = await ctrl.profiles();
              break;
            case "tabs":
              json = await ctrl.tabs(args ?? {});
              break;
            case "open":
              json = await ctrl.open(args?.url ?? args?.targetUrl);
              break;
            case "focus":
              json = await ctrl.focus(args?.targetId);
              break;
            case "close":
              json = await ctrl.close(args?.targetId);
              break;
            case "snapshot":
              json = await ctrl.snapshot(args ?? {});
              break;
            case "screenshot":
              json = await ctrl.screenshot(args ?? {});
              break;
            case "navigate":
              json = await ctrl.navigate({
                targetId: args?.targetId,
                url: args?.url ?? args?.targetUrl,
                timeoutMs: args?.timeoutMs,
              });
              break;
            case "console":
              json = await ctrl.console({ targetId: args?.targetId, level: args?.level });
              break;
            case "pdf":
              json = await ctrl.pdf({ targetId: args?.targetId });
              break;
            case "upload":
              json = await ctrl.upload(args ?? {});
              break;
            case "dialog":
              json = await ctrl.dialog(args ?? {});
              break;
            case "act":
              json = await ctrl.act(args ?? {});
              break;
            default:
              throw new Error(`Unsupported browser_cloud action: ${action}`);
          }
        } catch (err) {
          const cfg = readPluginCfg(api);
          const mode = cfg.stopOnError ?? "fatal";

          // Best-effort context for logs.
          let ctx: any = { action };
          let statusJson: any = null;
          try {
            const st = await ctrl.status();
            statusJson = st;
            ctx = {
              action,
              sessionId: (st as any)?.sessionId ?? null,
              cdpUrl: (st as any)?.cdpUrl ?? null,
              buStatus: (st as any)?.diag?.bu?.ok === true ? ((st as any).diag.bu.session?.status ?? null) : null,
              buFinishedAt: (st as any)?.diag?.bu?.ok === true ? ((st as any).diag.bu.session?.finishedAt ?? null) : null,
            };
          } catch {
            // ignore
          }

          const normalizedErr = isBuSessionExpiredFromStatus(statusJson)
            ? toBrowserSessionExpiredError(err)
            : err;

          // eslint-disable-next-line no-console
          console.error("[browser-cloud] tool error", {
            ...ctx,
            mode,
            fatal: isBrowserCloudFatalError(normalizedErr),
            err: normalizedErr instanceof Error ? normalizedErr.message : String(normalizedErr),
          });

          const shouldStop =
            mode === "always"
              ? true
              : mode === "never"
                ? false
                : isBrowserCloudFatalError(normalizedErr);

          if (shouldStop) {
            await ctrl.stop({ reason: `error:${action}` }).catch(() => {});
          }
          throw normalizedErr;
        } finally {
          (ctrl as any)["sessions"]?.endAction?.(action);
        }

        if (action === "snapshot" && json && typeof json === "object") {
          const parts: Array<{ type: "text" | "json"; text?: string; json?: unknown }> = [];
          const snap = json as Record<string, unknown>;
          const snapshotText = typeof snap.snapshot === "string" ? snap.snapshot : "";
          const refsObj = snap.refs && typeof snap.refs === "object" ? (snap.refs as Record<string, unknown>) : null;
          if (snapshotText) {
            parts.push({ type: "text", text: snapshotText });
          }
          if (refsObj) {
            const refKeys = Object.keys(refsObj);
            const sample = refKeys.slice(0, 40).join("\n");
            const summary = `refs: ${refKeys.length}${refKeys.length > 40 ? " (showing first 40)" : ""}
${sample}`;
            parts.push({ type: "text", text: summary });
          }
          parts.push({ type: "json", json });
          return { content: parts };
        }

        return { content: [{ type: "json", json }] };
      },
    },
    { optional: true },
  );
}
