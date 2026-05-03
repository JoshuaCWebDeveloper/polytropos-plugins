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
  return (
    process.env.OPENCLAW_SERVICE_KIND === "gateway" ||
    process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" ||
    !!process.env.OPENCLAW_SERVICE_MARKER
  );
}

export default function register(api: PluginApi) {
  if (!isGatewayRuntime()) return;
  let watcher: any = null;
  let inFlightSend = false;

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

      async function attemptSendCopiedSentinelOnce(trigger: string) {
        if (inFlightSend) return;
        inFlightSend = true;
        try {
          const { promises: fs } = await import("node:fs");

          let raw: string;
          try {
            raw = await fs.readFile(copiedSentinelPath, "utf-8");
          } catch {
            api.logger.info?.(`[restart-resume] ${trigger}: no copied sentinel at ${copiedSentinelPath}`);
            return;
          }

          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            api.logger.warn?.(`[restart-resume] ${trigger}: copied sentinel invalid JSON; keeping for manual recovery: ${copiedSentinelPath}`);
            return;
          }

          if (!parsed || parsed.version !== 1 || !parsed.payload) {
            api.logger.warn?.(`[restart-resume] ${trigger}: copied sentinel schema mismatch; keeping for manual recovery: ${copiedSentinelPath}`);
            return;
          }

          const payload = parsed.payload;
          const to = payload?.deliveryContext?.to;
          const channelId = extractChannelIdFromTo(to) ?? extractChannelIdFromSessionKey(payload?.sessionKey);
          if (!channelId) {
            api.logger.warn?.(
              `[restart-resume] ${trigger}: could not resolve target channel (deliveryContext.to=${String(to)} sessionKey=${String(payload?.sessionKey)}); keeping copied sentinel for manual recovery: ${copiedSentinelPath}`
            );
            return;
          }

          const body = formatRestartSentinelMessage(payload);
          const msg = `Gateway successfully restarted:\n${body}`;

          api.logger.info?.(
            `[restart-resume] ${trigger}: invoking send-to-channel.sh guildId=${guildId} channelId=${channelId} script=${sendScriptPath} (LOG_DIR=/tmp)`
          );

          const { execFile } = await import("node:child_process");
          const out = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            execFile(
              "bash",
              [sendScriptPath, guildId, channelId, msg],
              {
                timeout: 60000,
                env: { ...process.env, LOG_DIR: "/tmp" },
              },
              (err: any, stdout: string, stderr: string) => {
                if (err) return reject(Object.assign(err, { stdout, stderr }));
                resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
              }
            );
          });

          const stdout = out.stdout.trim();
          const stderr = out.stderr.trim();

          if (stdout) api.logger.info?.(`[restart-resume] ${trigger}: send-to-channel stdout:\n${stdout}`);
          if (stderr) api.logger.warn?.(`[restart-resume] ${trigger}: send-to-channel stderr:\n${stderr}`);

          const m = stdout.match(/Log:\s*(\/tmp\/openclaw-send-to-channel\.[^\s]+\.log)/);
          if (m?.[1]) api.logger.info?.(`[restart-resume] ${trigger}: send-to-channel runLog=${m[1]}`);


          api.logger.info?.(`[restart-resume] ${trigger}: send ok; deleting copied sentinel ${copiedSentinelPath}`);
          await fs.unlink(copiedSentinelPath).catch(() => {});
        } finally {
          inFlightSend = false;
        }
      }

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

          // 2) schedule exactly one post-restart send attempt
        });
      } catch (err) {
        api.logger.warn?.(`[restart-resume] fs.watch failed: ${String(err)}`);
      }

      // If we boot with a leftover copied sentinel, try once after a short delay.
      api.logger.info?.("[restart-resume] boot delay 5000ms");
      await sleep(5000);
      await attemptSendCopiedSentinelOnce("boot");
    },
    stop: async () => {
      try {
        watcher?.close?.();
      } catch {}
      watcher = null;

      try {
      } catch {}
    },
  });
}
