import { chromium } from "playwright-core";

const apiKey = (process.env.BROWSER_USE_API_KEY || "").trim();
const profileId = (process.env.BROWSER_USE_PROFILE_ID || "").trim();
const timeoutMin = Number.parseInt(process.env.BROWSER_USE_TIMEOUT_MIN || "5", 10);

if (!apiKey) {
  throw new Error("Missing env BROWSER_USE_API_KEY");
}
if (!profileId) {
  throw new Error("Missing env BROWSER_USE_PROFILE_ID");
}

async function createSession() {
  const res = await fetch("https://api.browser-use.com/api/v2/browsers", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
    },
    body: JSON.stringify({
      profileId,
      timeout: Math.max(1, Math.min(240, Math.round(timeoutMin))),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`create session failed: HTTP ${res.status} ${text}`);
  }
  return await res.json();
}

async function stopSession(sessionId) {
  const res = await fetch(`https://api.browser-use.com/api/v2/browsers/${sessionId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "X-Browser-Use-API-Key": apiKey,
    },
    body: JSON.stringify({ action: "stop" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`stop session failed: HTTP ${res.status} ${text}`);
  }
  return await res.json();
}

const session = await createSession();
const cdpUrl = String(session?.cdpUrl || "").trim();
if (!cdpUrl) throw new Error("BU returned no cdpUrl");

console.log("Session:", { id: session.id, liveUrl: session.liveUrl, cdpUrl });

const browser = await chromium.connectOverCDP(cdpUrl);
try {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  await page.goto("https://example.com", { timeout: 30_000 });
  const title = await page.title();
  console.log("Loaded:", { url: page.url(), title });
} finally {
  await browser.close().catch(() => {});
  await stopSession(session.id).catch(() => {});
}

console.log("Smoke OK");

