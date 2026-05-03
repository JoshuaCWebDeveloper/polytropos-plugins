export type BuSession = {
  id: string;
  status?: string;
  liveUrl?: string | null;
  cdpUrl?: string | null;
  timeoutAt?: string;
  startedAt?: string;
  finishedAt?: string | null;
};


export async function buCreateBrowserSession(opts: {
  apiKey: string;
  profileId: string;
  timeoutMin: number;
}): Promise<BuSession> {
  const res = await fetch("https://api.browser-use.com/api/v2/browsers", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Browser-Use-API-Key": opts.apiKey,
    },
    body: JSON.stringify({
      profileId: opts.profileId,
      timeout: Math.max(1, Math.min(240, Math.round(opts.timeoutMin))),
      // IMPORTANT: Browser Use defaults to a US residential proxy when proxyCountryCode is omitted.
      // Hardcode to null to disable proxies by default (cheaper) unless we intentionally add proxy support later.
      proxyCountryCode: null,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Browser Use Cloud create session failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as BuSession;
}

export async function buGetBrowserSession(opts: { apiKey: string; sessionId: string }): Promise<BuSession> {
  const res = await fetch(`https://api.browser-use.com/api/v2/browsers/${opts.sessionId}`, {
    method: "GET",
    headers: {
      "content-type": "application/json",
      "X-Browser-Use-API-Key": opts.apiKey,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Browser Use Cloud get session failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as BuSession;
}

export async function buStopBrowserSession(opts: { apiKey: string; sessionId: string }): Promise<BuSession> {
  const res = await fetch(`https://api.browser-use.com/api/v2/browsers/${opts.sessionId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "X-Browser-Use-API-Key": opts.apiKey,
    },
    body: JSON.stringify({ action: "stop" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Browser Use Cloud stop session failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as BuSession;
}
