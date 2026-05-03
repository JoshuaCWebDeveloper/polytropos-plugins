import type { GatewayBrowserUseCloudConfig } from "../config/types.gateway.ts";

export type BrowserUseCloudSession = {
  id: string;
  status?: string;
  liveUrl?: string | null;
  cdpUrl?: string | null;
  timeoutAt?: string;
  startedAt?: string;
  finishedAt?: string | null;
};

function requireApiKey(cfg: GatewayBrowserUseCloudConfig): string {
  const key = String(cfg.apiKey ?? "").trim();
  if (!key) {
    throw new Error("gateway.browserUseCloud.apiKey is required");
  }
  return key;
}

export async function createBrowserUseCloudSession(opts: {
  cfg: GatewayBrowserUseCloudConfig;
  profileId: string;
  timeoutMin: number;
  fetchImpl?: typeof fetch;
}): Promise<BrowserUseCloudSession> {
  const apiKey = requireApiKey(opts.cfg);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const res = await fetchImpl("https://api.browser-use.com/api/v2/browsers", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
    },
    body: JSON.stringify({
      profileId: opts.profileId,
      timeout: Math.max(1, Math.min(240, Math.round(opts.timeoutMin))),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Browser Use Cloud create session failed: HTTP ${res.status} ${text}`);
  }

  return (await res.json()) as BrowserUseCloudSession;
}

export async function stopBrowserUseCloudSession(opts: {
  cfg: GatewayBrowserUseCloudConfig;
  sessionId: string;
  fetchImpl?: typeof fetch;
}): Promise<BrowserUseCloudSession> {
  const apiKey = requireApiKey(opts.cfg);
  const fetchImpl = opts.fetchImpl ?? fetch;

  const res = await fetchImpl(`https://api.browser-use.com/api/v2/browsers/${opts.sessionId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
    },
    body: JSON.stringify({ action: "stop" }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Browser Use Cloud stop session failed: HTTP ${res.status} ${text}`);
  }

  return (await res.json()) as BrowserUseCloudSession;
}
