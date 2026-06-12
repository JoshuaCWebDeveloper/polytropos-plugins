import path from "node:path";

export const BACKGROUND_PARAMETER_SCHEMA = {
  type: "boolean",
  default: false,
  description:
    "Launch the command in a detached session and return immediately. Output is appended to the reported log file.",
} as const;

export type ToolSchemaContribution = {
  toolName: string;
  properties: Record<string, unknown>;
};

export type ExecParams = Record<string, unknown> & {
  background?: boolean;
  command?: unknown;
  cmd?: unknown;
};

export type BackgroundLaunch = {
  command: string;
  logPath: string;
};

export function createSchemaContributions(): ToolSchemaContribution[] {
  return ["exec_command"].map((toolName) => ({
    toolName,
    properties: {
      background: BACKGROUND_PARAMETER_SCHEMA,
    },
  }));
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function createBackgroundLaunch(options: {
  command: string;
  logDirectory: string;
  launchId: string;
}): BackgroundLaunch {
  const logPath = path.join(options.logDirectory, `${options.launchId}.log`);
  const quotedDirectory = shellQuote(options.logDirectory);
  const quotedLogPath = shellQuote(logPath);
  const quotedCommand = shellQuote(options.command);

  return {
    logPath,
    command: [
      `mkdir -p -- ${quotedDirectory}`,
      `log=${quotedLogPath}`,
      `/usr/bin/nohup /usr/bin/setsid /usr/bin/sh -c ${quotedCommand} </dev/null >>"$log" 2>&1 &`,
      `pid=$!`,
      `printf 'background_pid=%s\\nbackground_log=%s\\n' "$pid" "$log"`,
    ].join("\n"),
  };
}

export function rewriteExecParams(
  params: ExecParams,
  options: { logDirectory: string; launchId: string },
): { params: ExecParams; launch?: BackgroundLaunch } {
  if (params.background !== true) {
    return { params };
  }

  const sourceCommand =
    typeof params.command === "string"
      ? params.command
      : typeof params.cmd === "string"
        ? params.cmd
        : null;
  if (sourceCommand === null) {
    throw new Error("exec background mode requires a string command");
  }

  const launch = createBackgroundLaunch({
    command: sourceCommand,
    logDirectory: options.logDirectory,
    launchId: options.launchId,
  });
  const rewritten: ExecParams = { ...params };
  delete rewritten.background;
  if ("command" in params) {
    rewritten.command = launch.command;
  }
  if ("cmd" in params) {
    rewritten.cmd = launch.command;
  }

  return { params: rewritten, launch };
}
