import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

const plugin = {
  id: "sanitize-guard",
  name: "Sanitize Guard",
  description:
    "Workaround hook that nudges the agent away from trigger-phrases that cause a false rewrite in older releases.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean", default: true },
      scope: { type: "string", enum: ["main-only", "all"], default: "main-only" },
    },
  },
  register(api: OpenClawPluginApi) {
    const a0 = String(process.argv[0] ?? "").split(/[\\/]/).pop();
    const a1 = String(process.argv[1] ?? "").split(/[\\/]/).pop();
    const isGatewayRuntime = a0 === "openclaw-gateway" || a1 === "openclaw-gateway";
    if (!isGatewayRuntime) return;

    registerPluginHooksFromDir(api, "./hooks");
  },
};

export default plugin;
