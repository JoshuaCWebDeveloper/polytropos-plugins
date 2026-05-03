function requireApiKey(cfg) {
    const key = String(cfg.apiKey ?? "").trim();
    if (!key) {
        throw new Error("gateway.browserUseCloud.apiKey is required");
    }
    return key;
}
export async function createBrowserUseCloudSession(opts) {
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
    return (await res.json());
}
export async function stopBrowserUseCloudSession(opts) {
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
    return (await res.json());
}
//# sourceMappingURL=browser-use-cloud.js.map