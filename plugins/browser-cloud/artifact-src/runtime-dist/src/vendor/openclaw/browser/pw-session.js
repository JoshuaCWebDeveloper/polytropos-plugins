import { chromium } from "playwright-core";
import { formatErrorMessage } from "../infra/errors.ts";
import { withNoProxyForCdpUrl } from "./cdp-proxy-bypass.ts";
import { assertBrowserNavigationAllowed, assertBrowserNavigationResultAllowed, withBrowserNavigationPolicy, } from "./navigation-guard.ts";
const pageStates = new WeakMap();
const contextStates = new WeakMap();
const observedContexts = new WeakSet();
const observedPages = new WeakSet();
// Best-effort cache to make role refs stable even if Playwright returns a different Page object
// for the same CDP target across requests.
const roleRefsByTarget = new Map();
const MAX_ROLE_REFS_CACHE = 50;
const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;
let cached = null;
let connecting = null;
function normalizeCdpUrl(raw) {
    return raw.replace(/\/$/, "");
}
function getHeadersWithAuth(url, headers = {}) {
    const mergedHeaders = { ...headers };
    try {
        const parsed = new URL(url);
        const hasAuthHeader = Object.keys(mergedHeaders).some((key) => key.toLowerCase() === "authorization");
        if (hasAuthHeader) {
            return mergedHeaders;
        }
        if (parsed.username || parsed.password) {
            const auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString("base64");
            return { ...mergedHeaders, Authorization: `Basic ${auth}` };
        }
    }
    catch {
        // ignore
    }
    return mergedHeaders;
}
function findNetworkRequestById(state, id) {
    for (let i = state.requests.length - 1; i >= 0; i -= 1) {
        const candidate = state.requests[i];
        if (candidate && candidate.id === id) {
            return candidate;
        }
    }
    return undefined;
}
function roleRefsKey(cdpUrl, targetId) {
    return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}
export function rememberRoleRefsForTarget(opts) {
    const targetId = opts.targetId.trim();
    if (!targetId) {
        return;
    }
    roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
        refs: opts.refs,
        ...(opts.frameSelector ? { frameSelector: opts.frameSelector } : {}),
        ...(opts.mode ? { mode: opts.mode } : {}),
    });
    while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
        const first = roleRefsByTarget.keys().next();
        if (first.done) {
            break;
        }
        roleRefsByTarget.delete(first.value);
    }
}
export function storeRoleRefsForTarget(opts) {
    const state = ensurePageState(opts.page);
    state.roleRefs = opts.refs;
    state.roleRefsFrameSelector = opts.frameSelector;
    state.roleRefsMode = opts.mode;
    if (!opts.targetId?.trim()) {
        return;
    }
    rememberRoleRefsForTarget({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs: opts.refs,
        frameSelector: opts.frameSelector,
        mode: opts.mode,
    });
}
export function restoreRoleRefsForTarget(opts) {
    const targetId = opts.targetId?.trim() || "";
    if (!targetId) {
        return;
    }
    const cached = roleRefsByTarget.get(roleRefsKey(opts.cdpUrl, targetId));
    if (!cached) {
        return;
    }
    const state = ensurePageState(opts.page);
    if (state.roleRefs) {
        return;
    }
    state.roleRefs = cached.refs;
    state.roleRefsFrameSelector = cached.frameSelector;
    state.roleRefsMode = cached.mode;
}
export function ensurePageState(page) {
    const existing = pageStates.get(page);
    if (existing) {
        return existing;
    }
    const state = {
        console: [],
        errors: [],
        requests: [],
        requestIds: new WeakMap(),
        nextRequestId: 0,
        armIdUpload: 0,
        armIdDialog: 0,
        armIdDownload: 0,
    };
    pageStates.set(page, state);
    if (!observedPages.has(page)) {
        observedPages.add(page);
        page.on("console", (msg) => {
            const entry = {
                type: msg.type(),
                text: msg.text(),
                timestamp: new Date().toISOString(),
                location: msg.location(),
            };
            state.console.push(entry);
            if (state.console.length > MAX_CONSOLE_MESSAGES) {
                state.console.shift();
            }
        });
        page.on("pageerror", (err) => {
            state.errors.push({
                message: err?.message ? String(err.message) : String(err),
                name: err?.name ? String(err.name) : undefined,
                stack: err?.stack ? String(err.stack) : undefined,
                timestamp: new Date().toISOString(),
            });
            if (state.errors.length > MAX_PAGE_ERRORS) {
                state.errors.shift();
            }
        });
        page.on("request", (req) => {
            state.nextRequestId += 1;
            const id = `r${state.nextRequestId}`;
            state.requestIds.set(req, id);
            state.requests.push({
                id,
                timestamp: new Date().toISOString(),
                method: req.method(),
                url: req.url(),
                resourceType: req.resourceType(),
            });
            if (state.requests.length > MAX_NETWORK_REQUESTS) {
                state.requests.shift();
            }
        });
        page.on("response", (resp) => {
            const req = resp.request();
            const id = state.requestIds.get(req);
            if (!id) {
                return;
            }
            const rec = findNetworkRequestById(state, id);
            if (!rec) {
                return;
            }
            rec.status = resp.status();
            rec.ok = resp.ok();
        });
        page.on("requestfailed", (req) => {
            const id = state.requestIds.get(req);
            if (!id) {
                return;
            }
            const rec = findNetworkRequestById(state, id);
            if (!rec) {
                return;
            }
            rec.failureText = req.failure()?.errorText;
            rec.ok = false;
        });
        page.on("close", () => {
            pageStates.delete(page);
            observedPages.delete(page);
        });
    }
    return state;
}
function observeContext(context) {
    if (observedContexts.has(context)) {
        return;
    }
    observedContexts.add(context);
    ensureContextState(context);
    for (const page of context.pages()) {
        ensurePageState(page);
    }
    context.on("page", (page) => ensurePageState(page));
}
export function ensureContextState(context) {
    const existing = contextStates.get(context);
    if (existing) {
        return existing;
    }
    const state = { traceActive: false };
    contextStates.set(context, state);
    return state;
}
function observeBrowser(browser) {
    for (const context of browser.contexts()) {
        observeContext(context);
    }
}
async function resolvePlaywrightCdpEndpoint(opts) {
    const normalized = normalizeCdpUrl(opts.cdpUrl);
    let u;
    try {
        u = new URL(normalized);
    }
    catch {
        return normalized;
    }
    if (u.protocol === "ws:" || u.protocol === "wss:") {
        return normalized;
    }
    // If provider returns an https base URL (Browser Use Cloud), Playwright still wants a websocket
    // endpoint. We poll the version JSON at the root until it becomes available.
    if (u.protocol === "http:" || u.protocol === "https:") {
        const deadline = Date.now() + Math.max(1000, opts.timeoutMs);
        while (Date.now() < deadline) {
            const controller = new AbortController();
            const remaining = Math.max(500, Math.min(2000, deadline - Date.now()));
            const t = setTimeout(() => controller.abort(), remaining);
            try {
                const res = await fetch(normalized, { signal: controller.signal });
                if (res.ok) {
                    const json = (await res.json().catch(() => null));
                    const ws = String(json?.webSocketDebuggerUrl ?? "").trim();
                    if (ws) {
                        return ws;
                    }
                }
            }
            catch {
                // ignore and retry until deadline
            }
            finally {
                clearTimeout(t);
            }
            await new Promise((r) => setTimeout(r, 350));
        }
        throw new Error(`CDP endpoint not ready (no webSocketDebuggerUrl at ${normalized} within ${opts.timeoutMs}ms)`);
    }
    return normalized;
}
async function connectBrowser(cdpUrl) {
    const normalized = normalizeCdpUrl(cdpUrl);
    if (cached?.cdpUrl === normalized) {
        return cached;
    }
    // eslint-disable-next-line no-console
    console.error("[browser-cloud] connectBrowser: new", {
        requested: cdpUrl,
        normalized,
        hadCached: Boolean(cached),
        cachedCdpUrl: cached?.cdpUrl ?? null,
    });
    if (connecting) {
        return await connecting;
    }
    const connectWithRetry = async () => {
        let lastErr;
        for (let attempt = 0; attempt < 6; attempt += 1) {
            try {
                // BU CDP endpoints can be briefly unavailable; use a larger backoff window.
                const timeout = Math.min(30_000, 5000 + attempt * 5000);
                const endpoint = await resolvePlaywrightCdpEndpoint({ cdpUrl: normalized, timeoutMs: timeout });
                // eslint-disable-next-line no-console
                console.error("[browser-cloud] connectBrowser: resolved endpoint", { normalized, endpoint });
                const headers = getHeadersWithAuth(endpoint);
                // Bypass proxy for loopback CDP connections (#31219)
                // endpoint is always a websocket URL by construction.
                const browser = await withNoProxyForCdpUrl(endpoint, () => chromium.connectOverCDP(endpoint, { timeout, headers }));
                const onDisconnected = () => {
                    if (cached?.browser === browser) {
                        cached = null;
                    }
                };
                const connected = { browser, cdpUrl: normalized, onDisconnected };
                cached = connected;
                browser.on("disconnected", onDisconnected);
                observeBrowser(browser);
                return connected;
            }
            catch (err) {
                lastErr = err;
                const delay = 250 + attempt * 250;
                await new Promise((r) => setTimeout(r, delay));
            }
        }
        if (lastErr instanceof Error) {
            throw lastErr;
        }
        const message = lastErr ? formatErrorMessage(lastErr) : "CDP connect failed";
        throw new Error(message);
    };
    connecting = connectWithRetry().finally(() => {
        connecting = null;
    });
    return await connecting;
}
export { connectBrowser };
async function getAllPages(browser) {
    const contexts = browser.contexts();
    const pages = contexts.flatMap((c) => c.pages());
    return pages;
}
async function pageTargetId(page) {
    const session = await page.context().newCDPSession(page);
    try {
        const info = (await session.send("Target.getTargetInfo"));
        const targetId = String(info?.targetInfo?.targetId ?? "").trim() || null;
        // eslint-disable-next-line no-console
        console.error("[browser-cloud] pageTargetId", { url: page.url(), targetId });
        return targetId;
    }
    finally {
        await session.detach().catch(() => { });
    }
}
async function findPageByTargetId(browser, targetId, cdpUrl) {
    const pages = await getAllPages(browser);
    let resolvedViaCdp = false;
    // First, try the standard CDP session approach
    for (const page of pages) {
        let tid = null;
        try {
            tid = await pageTargetId(page);
            resolvedViaCdp = true;
        }
        catch {
            tid = null;
        }
        if (tid && tid === targetId) {
            return page;
        }
    }
    // Extension relays can block CDP attachment APIs entirely. If that happens and
    // Playwright only exposes one page, return it as the best available mapping.
    if (!resolvedViaCdp && pages.length === 1) {
        return pages[0];
    }
    // If CDP sessions fail (e.g., extension relay blocks Target.attachToBrowserTarget),
    // fall back to URL-based matching using the /json/list endpoint
    if (cdpUrl) {
        try {
            const baseUrl = cdpUrl
                .replace(/\/+$/, "")
                .replace(/^ws:/, "http:")
                .replace(/\/cdp$/, "");
            const listUrl = `${baseUrl}/json/list`;
            const response = await fetch(listUrl, { headers: getHeadersWithAuth(listUrl) });
            if (response.ok) {
                const targets = (await response.json());
                const target = targets.find((t) => t.id === targetId);
                if (target) {
                    // Try to find a page with matching URL
                    const urlMatch = pages.filter((p) => p.url() === target.url);
                    if (urlMatch.length === 1) {
                        return urlMatch[0];
                    }
                    // If multiple URL matches, use index-based matching as fallback
                    // This works when Playwright and the relay enumerate tabs in the same order
                    if (urlMatch.length > 1) {
                        const sameUrlTargets = targets.filter((t) => t.url === target.url);
                        if (sameUrlTargets.length === urlMatch.length) {
                            const idx = sameUrlTargets.findIndex((t) => t.id === targetId);
                            if (idx >= 0 && idx < urlMatch.length) {
                                return urlMatch[idx];
                            }
                        }
                    }
                }
            }
        }
        catch {
            // Ignore fetch errors and fall through to return null
        }
    }
    return null;
}
export { findPageByTargetId };
async function resolvePageByTargetIdOrThrow(opts) {
    const { browser } = await connectBrowser(opts.cdpUrl);
    const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
    if (!page) {
        throw new Error("tab not found");
    }
    return page;
}
export async function getPageForTargetId(opts) {
    const { browser } = await connectBrowser(opts.cdpUrl);
    // Cloud CDP providers can briefly report zero pages while targets are being reaped/recreated
    // (observed after file uploads). Retry once before failing.
    let pages = await getAllPages(browser);
    if (!pages.length) {
        await new Promise((r) => setTimeout(r, 500));
        pages = await getAllPages(browser);
    }
    if (!pages.length) {
        // Best-effort: create a new page so callers can recover instead of crashing.
        const ctx = browser.contexts()[0];
        if (ctx) {
            const p = await ctx.newPage();
            return p;
        }
        throw new Error("No pages available in the connected browser.");
    }
    // Prefer a real URL page over about:blank.
    const first = pages.find((p) => p.url() !== "about:blank") ?? pages[0];
    if (!opts.targetId) {
        return first;
    }
    const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
    if (!found) {
        if (pages.length === 1) {
            return first;
        }
        // Fallback: return the first page rather than throwing; callers may have a stale target id.
        return first;
    }
    return found;
}
export function refLocator(page, ref) {
    const normalized = ref.startsWith("@")
        ? ref.slice(1)
        : ref.startsWith("ref=")
            ? ref.slice(4)
            : ref;
    if (/^e\d+$/.test(normalized)) {
        const state = pageStates.get(page);
        if (state?.roleRefsMode === "aria") {
            const scope = state.roleRefsFrameSelector
                ? page.frameLocator(state.roleRefsFrameSelector)
                : page;
            return scope.locator(`aria-ref=${normalized}`);
        }
        const info = state?.roleRefs?.[normalized];
        if (!info) {
            throw new Error(`Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`);
        }
        const scope = state?.roleRefsFrameSelector
            ? page.frameLocator(state.roleRefsFrameSelector)
            : page;
        const locAny = scope;
        const locator = info.name
            ? locAny.getByRole(info.role, { name: info.name, exact: true })
            : locAny.getByRole(info.role);
        return info.nth !== undefined ? locator.nth(info.nth) : locator;
    }
    return page.locator(`aria-ref=${normalized}`);
}
export async function closePlaywrightBrowserConnection() {
    const cur = cached;
    cached = null;
    connecting = null;
    if (!cur) {
        return;
    }
    if (cur.onDisconnected && typeof cur.browser.off === "function") {
        cur.browser.off("disconnected", cur.onDisconnected);
    }
    await cur.browser.close().catch(() => { });
}
/**
 * Best-effort cancellation for stuck page operations.
 *
 * Playwright serializes CDP commands per page; a long-running or stuck operation (notably evaluate)
 * can block all subsequent commands. We cannot safely "cancel" an individual command, and we do
 * not want to close the actual Chromium tab. Instead, we disconnect Playwright's CDP connection
 * so in-flight commands fail fast and the next request reconnects transparently.
 *
 * IMPORTANT: We CANNOT call Connection.close() because Playwright shares a single Connection
 * across all objects (BrowserType, Browser, etc.). Closing it corrupts the entire Playwright
 * instance, preventing reconnection.
 *
 * Instead we:
 * 1. Null out `cached` so the next call triggers a fresh connectOverCDP
 * 2. Fire-and-forget browser.close() — it may hang but won't block us
 * 3. The next connectBrowser() creates a completely new CDP WebSocket connection
 *
 * The old browser.close() eventually resolves when the in-browser evaluate timeout fires,
 * or the old connection gets GC'd. Either way, it doesn't affect the fresh connection.
 */
export async function forceDisconnectPlaywrightForTarget(opts) {
    const normalized = normalizeCdpUrl(opts.cdpUrl);
    if (cached?.cdpUrl !== normalized) {
        return;
    }
    const cur = cached;
    cached = null;
    // Also clear `connecting` so the next call does a fresh connectOverCDP
    // rather than awaiting a stale promise.
    connecting = null;
    if (cur) {
        // Remove the "disconnected" listener to prevent the old browser's teardown
        // from racing with a fresh connection and nulling the new `cached`.
        if (cur.onDisconnected && typeof cur.browser.off === "function") {
            cur.browser.off("disconnected", cur.onDisconnected);
        }
        // Fire-and-forget: don't await because browser.close() may hang on the stuck CDP pipe.
        cur.browser.close().catch(() => { });
    }
}
/**
 * List all pages/tabs from the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/list is ephemeral.
 */
export async function listPagesViaPlaywright(opts) {
    const { browser } = await connectBrowser(opts.cdpUrl);
    const pages = await getAllPages(browser);
    const results = [];
    for (const page of pages) {
        const tid = await pageTargetId(page).catch(() => null);
        if (tid) {
            results.push({
                targetId: tid,
                title: await page.title().catch(() => ""),
                url: page.url(),
                type: "page",
            });
        }
    }
    return results;
}
/**
 * Create a new page/tab using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/new is ephemeral.
 * Returns the new page's targetId and metadata.
 */
export async function createPageViaPlaywright(opts) {
    const { browser } = await connectBrowser(opts.cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    ensureContextState(context);
    const page = await context.newPage();
    ensurePageState(page);
    // Navigate to the URL
    const targetUrl = opts.url.trim() || "about:blank";
    if (targetUrl !== "about:blank") {
        const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy);
        await assertBrowserNavigationAllowed({
            url: targetUrl,
            ...navigationPolicy,
        });
        await page.goto(targetUrl, { timeout: 30_000 }).catch(() => {
            // Navigation might fail for some URLs, but page is still created
        });
        await assertBrowserNavigationResultAllowed({
            url: page.url(),
            ...navigationPolicy,
        });
    }
    // Get the targetId for this page
    const tid = await pageTargetId(page).catch(() => null);
    if (!tid) {
        throw new Error("Failed to get targetId for new page");
    }
    // Debug: compare against browser-level target list.
    try {
        const session = await browser.newBrowserCDPSession();
        try {
            const targets = (await session.send("Target.getTargets"));
            const infos = Array.isArray(targets?.targetInfos) ? targets.targetInfos : [];
            // eslint-disable-next-line no-console
            console.error("[browser-cloud] createPageViaPlaywright targets", {
                tid,
                url: page.url(),
                targetCount: infos.length,
                targets: infos.map((t) => ({
                    targetId: String(t?.targetId ?? ""),
                    type: String(t?.type ?? ""),
                    url: String(t?.url ?? ""),
                    title: String(t?.title ?? ""),
                })),
            });
        }
        finally {
            await session.detach().catch(() => { });
        }
    }
    catch {
        // ignore
    }
    return {
        targetId: tid,
        title: await page.title().catch(() => ""),
        url: page.url(),
        type: "page",
    };
}
/**
 * Close a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/close is ephemeral.
 */
export async function closePageByTargetIdViaPlaywright(opts) {
    try {
        const page = await resolvePageByTargetIdOrThrow(opts);
        await page.close();
        return;
    }
    catch (err) {
        // Fallback: close via Target domain when Playwright cannot resolve a Page handle.
        const { browser } = await connectBrowser(opts.cdpUrl);
        const session = await browser.newBrowserCDPSession();
        try {
            // Debug: confirm whether the targetId is present from the browser-target perspective.
            try {
                const targets = (await session.send("Target.getTargets"));
                const ids = Array.isArray(targets?.targetInfos)
                    ? targets.targetInfos.map((t) => String(t?.targetId ?? "").trim()).filter(Boolean)
                    : [];
                // eslint-disable-next-line no-console
                console.error("[browser-cloud] close fallback: target presence", {
                    requestedTargetId: opts.targetId,
                    present: ids.includes(opts.targetId),
                    targetCount: ids.length,
                });
            }
            catch {
                // ignore
            }
            await session.send("Target.closeTarget", { targetId: opts.targetId });
            return;
        }
        finally {
            await session.detach().catch(() => { });
        }
    }
}
/**
 * Focus a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/activate can be ephemeral.
 */
export async function focusPageByTargetIdViaPlaywright(opts) {
    try {
        const page = await resolvePageByTargetIdOrThrow(opts);
        try {
            await page.bringToFront();
            return;
        }
        catch {
            const session = await page.context().newCDPSession(page);
            try {
                await session.send("Page.bringToFront");
                return;
            }
            finally {
                await session.detach().catch(() => { });
            }
        }
    }
    catch (err) {
        // Fallback: activate via Target domain when Playwright cannot resolve a Page handle.
        const { browser } = await connectBrowser(opts.cdpUrl);
        const session = await browser.newBrowserCDPSession();
        try {
            // Debug: confirm whether the targetId is present from the browser-target perspective.
            try {
                const targets = (await session.send("Target.getTargets"));
                const ids = Array.isArray(targets?.targetInfos)
                    ? targets.targetInfos.map((t) => String(t?.targetId ?? "").trim()).filter(Boolean)
                    : [];
                // eslint-disable-next-line no-console
                console.error("[browser-cloud] focus fallback: target presence", {
                    requestedTargetId: opts.targetId,
                    present: ids.includes(opts.targetId),
                    targetCount: ids.length,
                });
            }
            catch {
                // ignore
            }
            await session.send("Target.activateTarget", { targetId: opts.targetId });
            return;
        }
        finally {
            await session.detach().catch(() => { });
        }
    }
}
//# sourceMappingURL=pw-session.js.map