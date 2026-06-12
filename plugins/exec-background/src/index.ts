import crypto from "node:crypto";
import path from "node:path";

import {
  createSchemaContributions,
  rewriteExecParams,
  type ExecParams,
  type ToolSchemaContribution,
} from "./background.js";

type PluginConfig = {
  enabled?: boolean;
  logDirectory?: string;
};

type PluginApi = {
  pluginConfig?: PluginConfig;
  logger: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  on: (
    hookName: "before_tool_call",
    handler: (event: { toolName?: string; params?: ExecParams }) => unknown,
    options?: { priority?: number },
  ) => void;
  registerToolSchemaContribution?: (contribution: ToolSchemaContribution) => void;
};

const EXEC_TOOL_NAMES = new Set(["exec_command", "functions.exec_command"]);

function resolveLogDirectory(config: PluginConfig): string {
  if (config.logDirectory?.trim()) {
    return path.resolve(config.logDirectory.trim());
  }
  return "/tmp/openclaw-exec-background";
}

export default function execBackgroundPlugin(api: PluginApi): void {
  const config = api.pluginConfig ?? {};
  if (config.enabled === false) {
    return;
  }

  if (api.registerToolSchemaContribution) {
    for (const contribution of createSchemaContributions()) {
      api.registerToolSchemaContribution(contribution);
    }
  } else {
    api.logger.warn?.(
      "[exec-background] core does not expose registerToolSchemaContribution; background calls require a core schema contribution for exec_command",
    );
  }

  const logDirectory = resolveLogDirectory(config);
  api.on(
    "before_tool_call",
    (event) => {
      if (!event.toolName || !EXEC_TOOL_NAMES.has(event.toolName)) {
        return;
      }
      if (event.params?.background !== true) {
        return;
      }

      const { params, launch } = rewriteExecParams(event.params, {
        logDirectory,
        launchId: `${Date.now()}-${crypto.randomUUID()}`,
      });
      api.logger.info?.(
        `[exec-background] detached ${event.toolName} output=${launch?.logPath ?? "unknown"}`,
      );
      return { params };
    },
    { priority: 100 },
  );
}
