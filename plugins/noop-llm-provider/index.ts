import http from "node:http";

type PluginApi = {
  pluginConfig: any;
  logger: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  // Newer OpenClaw plugin API: services instead of lifecycle hooks.
  registerService?: (service: {
    id: string;
    start: () => Promise<void> | void;
    stop: () => Promise<void> | void;
  }) => void;
  // Back-compat (older API). If present, we can still hook it.
  on?: (hookName: string, handler: (event: any, ctx: any) => any, opts?: { priority?: number }) => void;
};

const SILENT = "NO_REPLY";

function json(res: http.ServerResponse, code: number, body: any) {
  const text = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(text));
  res.end(text);
}

function notFound(res: http.ServerResponse) {
  res.statusCode = 404;
  res.end("not found");
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function isGatewayRuntime(): boolean {
  // Gateway daemon is typically launched as `node .../dist/index.js gateway ...`.
  // The reliable signal is the service env markers that OpenClaw sets for the daemon.
  return (
    process.env.OPENCLAW_SERVICE_KIND === "gateway" ||
    process.env.OPENCLAW_SYSTEMD_UNIT === "openclaw-gateway.service" ||
    !!process.env.OPENCLAW_SERVICE_MARKER
  );
}

function createServer(api: PluginApi) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

      // Minimal OpenAI compatibility.
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await readBody(req).catch(() => "");
        return json(res, 200, {
          id: "chatcmpl-noop",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "noop",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: SILENT },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/completions") {
        await readBody(req).catch(() => "");
        return json(res, 200, {
          id: "cmpl-noop",
          object: "text_completion",
          created: Math.floor(Date.now() / 1000),
          model: "noop",
          choices: [{ index: 0, text: SILENT, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      return notFound(res);
    } catch (err: any) {
      api.logger.warn?.(`[noop-llm-provider] request error: ${String(err)}`);
      res.statusCode = 500;
      res.end("error");
    }
  });
}

export default function register(api: PluginApi) {
  if (!isGatewayRuntime()) return;

  const cfg = api.pluginConfig ?? {};
  if (cfg.enabled === false) {
    api.logger.info?.("[noop-llm-provider] disabled");
    return;
  }

  const host = String(cfg.host ?? "127.0.0.1");
  const port = Number(cfg.port ?? 19999);

  let server: http.Server | null = null;

  async function start() {
    if (server) return;
    server = createServer(api);

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(port, host, () => resolve());
    });

    api.logger.info?.(`[noop-llm-provider] listening on http://${host}:${port}`);
  }

  async function stop() {
    if (!server) return;
    const s = server;
    server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    api.logger.info?.("[noop-llm-provider] stopped");
  }

  // Preferred: registerService (current API)
  if (api.registerService) {
    api.registerService({ id: "noop-llm-provider", start, stop });
    return;
  }

  // Fallback: legacy hook API
  if (api.on) {
    api.on("gateway_start", start, { priority: 50 });
    api.on("gateway_stop", stop, { priority: 50 });
    return;
  }

  api.logger.warn?.("[noop-llm-provider] no supported plugin lifecycle API found (missing registerService/on)");
}
