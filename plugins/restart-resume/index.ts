type PluginApi = {
  id: string;
  config: any;
  pluginConfig: any;
  logger: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  registerService: (service: {
    id: string;
    start: () => Promise<void> | void;
    stop: () => Promise<void> | void;
  }) => void;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function expandHome(p: string) {
  const s = String(p ?? "").trim();
  if (!s) return s;
  if (s === "~") return process.env.HOME || s;
  if (s.startsWith("~/")) return (process.env.HOME || "") + s.slice(1);
  return s;
}

function summarizeRestartSentinel(payload: any) {
  return `Gateway restart ${payload.kind} ${payload.status}${payload.stats?.mode ? ` (${payload.stats.mode})` : ""}`.trim();
}

function formatRestartSentinelMessage(payload: any) {
  const message = String(payload?.message ?? "").trim();
  if (message && !payload?.stats) return message;
  const lines: string[] = [summarizeRestartSentinel(payload)];
  if (message) lines.push(message);
  const reason = String(payload?.stats?.reason ?? "").trim();
  if (reason) lines.push(`Reason: ${reason}`);
  const doctorHint = String(payload?.doctorHint ?? "").trim();
  if (doctorHint) lines.push(doctorHint);
  return lines.join("\n");
}

function extractChannelIdFromTo(to: string | undefined | null): string | null {
  const s = String(to ?? "").trim();
  const m = s.match(/^channel:(\d{10,})$/);
  return m ? m[1] : null;
}

function extractChannelIdFromSessionKey(sessionKey: string | undefined | null): string | null {
  const s = String(sessionKey ?? "");
  const m = s.match(/:discord:channel:(\d{10,})/);
  return m ? m[1] : null;
}

type DeliveryAttemptResult = "missing" | "retained" | "retry" | "sent";

type DeliveryOptions = {
  copiedSentinelPath: string;
  sendScriptPath: string;
  guildId: string;
  logger: PluginApi["logger"];
};

export async function attemptSendCopiedSentinel(
  opts: DeliveryOptions,
  trigger: string,
): Promise<DeliveryAttemptResult> {
  const { promises: fs } = await import("node:fs");

  let raw: string;
  try {
    raw = await fs.readFile(opts.copiedSentinelPath, "utf-8");
  } catch {
    opts.logger.info?.(
      `[restart-resume] ${trigger}: no copied sentinel at ${opts.copiedSentinelPath}`,
    );
    return "missing";
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    opts.logger.warn?.(
      `[restart-resume] ${trigger}: copied sentinel invalid JSON; keeping for manual recovery: ${opts.copiedSentinelPath}`,
    );
    return "retained";
  }

  if (!parsed || parsed.version !== 1 || !parsed.payload) {
    opts.logger.warn?.(
      `[restart-resume] ${trigger}: copied sentinel schema mismatch; keeping for manual recovery: ${opts.copiedSentinelPath}`,
    );
    return "retained";
  }

  const payload = parsed.payload;
  const to = payload?.deliveryContext?.to;
  const channelId =
    extractChannelIdFromTo(to) ??
    extractChannelIdFromSessionKey(payload?.sessionKey);
  if (!channelId) {
    opts.logger.warn?.(
      `[restart-resume] ${trigger}: could not resolve target channel (deliveryContext.to=${String(to)} sessionKey=${String(payload?.sessionKey)}); keeping copied sentinel for manual recovery: ${opts.copiedSentinelPath}`,
    );
    return "retained";
  }

  const body = formatRestartSentinelMessage(payload);
  const msg = `Gateway successfully restarted:\n${body}`;

  opts.logger.info?.(
    `[restart-resume] ${trigger}: invoking send-to-channel.sh guildId=${opts.guildId} channelId=${channelId} script=${opts.sendScriptPath} (LOG_DIR=/tmp)`,
  );

  const { execFile } = await import("node:child_process");
  let out: { stdout: string; stderr: string };
  try {
    out = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        execFile(
          "bash",
          [opts.sendScriptPath, opts.guildId, channelId, msg],
          {
            timeout: 60000,
            env: { ...process.env, LOG_DIR: "/tmp" },
          },
          (err: any, stdout: string, stderr: string) => {
            if (err) {
              return reject(
                Object.assign(err, {
                  stdout: String(stdout ?? ""),
                  stderr: String(stderr ?? ""),
                }),
              );
            }
            resolve({
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
            });
          },
        );
      },
    );
  } catch (err: any) {
    const stdout = String(err?.stdout ?? "").trim();
    const stderr = String(err?.stderr ?? "").trim();
    const detail = stderr || stdout || String(err);
    opts.logger.warn?.(
      `[restart-resume] ${trigger}: send failed; keeping copied sentinel for retry: ${detail}`,
    );
    return "retry";
  }

  const stdout = out.stdout.trim();
  const stderr = out.stderr.trim();

  if (stdout) {
    opts.logger.info?.(
      `[restart-resume] ${trigger}: send-to-channel stdout:\n${stdout}`,
    );
  }
  if (stderr) {
    opts.logger.warn?.(
      `[restart-resume] ${trigger}: send-to-channel stderr:\n${stderr}`,
    );
  }

  const m = stdout.match(
    /Log:\s*(\/tmp\/openclaw-send-to-channel\.[^\s]+\.log)/,
  );
  if (m?.[1]) {
    opts.logger.info?.(
      `[restart-resume] ${trigger}: send-to-channel runLog=${m[1]}`,
    );
  }

  opts.logger.info?.(
    `[restart-resume] ${trigger}: send ok; deleting copied sentinel ${opts.copiedSentinelPath}`,
  );
  await fs.unlink(opts.copiedSentinelPath).catch(() => {});
  return "sent";
}

export async function consumeCopiedSentinelWithRetry(opts: DeliveryOptions & {
  initialDelayMs?: number;
  retryTimeoutMs: number;
  retryIntervalMs: number;
  isCancelled?: () => boolean;
}) {
  const initialDelayMs = Math.max(0, opts.initialDelayMs ?? 5000);
  const retryTimeoutMs = Math.max(0, opts.retryTimeoutMs);
  const retryIntervalMs = Math.max(1, opts.retryIntervalMs);

  if (initialDelayMs > 0) await sleep(initialDelayMs);
  if (opts.isCancelled?.()) return;

  const deadline = Date.now() + retryTimeoutMs;
  let attempt = 1;
  while (!opts.isCancelled?.()) {
    const result = await attemptSendCopiedSentinel(opts, `boot attempt ${attempt}`);
    if (result !== "retry") return;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      opts.logger.warn?.(
        `[restart-resume] boot: delivery retry timeout exhausted; keeping copied sentinel for the next restart: ${opts.copiedSentinelPath}`,
      );
      return;
    }

    await sleep(Math.min(retryIntervalMs, remainingMs));
    attempt += 1;
  }
}

async function copySentinelIfPresent(opts: {
  stateDir: string;
  copiedSentinelPath: string;
  logger: PluginApi["logger"];
}) {
  const { promises: fs } = await import("node:fs");
  const path = await import("node:path");

  const src = path.join(opts.stateDir, "restart-sentinel.json");
  const dst = opts.copiedSentinelPath;
  const tmp = `${dst}.tmp.${process.pid}`;

  try {
    await fs.copyFile(src, tmp);
    await fs.rename(tmp, dst);
    opts.logger.info?.(`[restart-resume] copied restart sentinel ${src} -> ${dst}`);
  } catch {
    try {
      await fs.unlink(tmp);
    } catch {}
  }
}

function isGatewayRuntime(): boolean {
  const argv = process.argv.map((arg) => String(arg));
  return (
    process.env.OPENCLAW_SERVICE_KIND === "gateway" ||
    process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" ||
    !!process.env.OPENCLAW_SERVICE_MARKER ||
    argv.includes("gateway")
  );
}

export default function register(api: PluginApi) {
  if (!isGatewayRuntime()) return;
  let watcher: any = null;
  let runGeneration = 0;

  api.registerService({
    id: "restart-resume",
    start: async () => {
      const cfg = api.pluginConfig ?? {};
      if (cfg.enabled === false) {
        api.logger.info?.("[restart-resume] disabled");
        return;
      }

      const copiedSentinelPath = expandHome(cfg.copiedSentinelPath ?? "~/.openclaw/restart-sentinel.copied.json");
      const sendScriptPath = String(cfg.sendScriptPath ?? "/home/ec2-user/.openclaw/workspace-discord-general/routines/send-to-channel/send-to-channel.sh");
      const guildId = String(cfg.guildId ?? "1465502729383186474");
      const retryTimeoutMs = Number(cfg.healthTimeoutMs ?? 60000);
      const retryIntervalMs = Number(cfg.healthPollIntervalMs ?? 500);
      const generation = ++runGeneration;

      // Watch for restart-sentinel.json writes. This is our SIGUSR1 interception point.
      const path = await import("node:path");
      const stateDir = path.dirname(expandHome("~/.openclaw/restart-sentinel.json"));
      api.logger.info?.(`[restart-resume] starting watcher on ${stateDir}`);

      const { watch } = await import("node:fs");
      try {
        watcher = watch(stateDir, { persistent: false }, (_eventType, filename) => {
          if (!filename) return;
          if (String(filename) !== "restart-sentinel.json") return;

          // 1) copy immediately
          void copySentinelIfPresent({ stateDir, copiedSentinelPath, logger: api.logger });
        });
      } catch (err) {
        api.logger.warn?.(`[restart-resume] fs.watch failed: ${String(err)}`);
      }

      // Let gateway startup finish before using the gateway-backed send script.
      api.logger.info?.(
        `[restart-resume] scheduling copied sentinel delivery after 5000ms (retry timeout ${retryTimeoutMs}ms)`,
      );
      void consumeCopiedSentinelWithRetry({
        copiedSentinelPath,
        sendScriptPath,
        guildId,
        logger: api.logger,
        retryTimeoutMs,
        retryIntervalMs,
        isCancelled: () => generation !== runGeneration,
      }).catch((err) => {
        api.logger.error?.(
          `[restart-resume] copied sentinel delivery failed unexpectedly: ${String(err)}`,
        );
      });
    },
    stop: async () => {
      runGeneration += 1;
      try {
        watcher?.close?.();
      } catch {}
      watcher = null;
    },
  });
}
