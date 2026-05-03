import path from "node:path";
import fs from "node:fs/promises";
import { BrowserUseCloudSessionManager } from "./browser-cloud-session.ts";
import { saveMediaBuffer } from "./media-store.ts";
import { closePageByTargetIdViaPlaywright, connectBrowser, createPageViaPlaywright, focusPageByTargetIdViaPlaywright, getPageForTargetId, listPagesViaPlaywright, refLocator, ensurePageState, } from "./vendor/openclaw/browser/pw-session.ts";
import { navigateViaPlaywright, pdfViaPlaywright, snapshotAiViaPlaywright, snapshotAriaViaPlaywright, snapshotRoleViaPlaywright, resizeViewportViaPlaywright, closePageViaPlaywright, } from "./vendor/openclaw/browser/pw-tools-core.snapshot.ts";
import { clickViaPlaywright, dragViaPlaywright, fillFormViaPlaywright, hoverViaPlaywright, pressKeyViaPlaywright, selectOptionViaPlaywright, typeViaPlaywright, waitForViaPlaywright, evaluateViaPlaywright, takeScreenshotViaPlaywright, screenshotWithLabelsViaPlaywright, setInputFilesViaPlaywright, uploadFilesToPage, } from "./vendor/openclaw/browser/pw-tools-core.interactions.ts";
import { getConsoleMessagesViaPlaywright } from "./vendor/openclaw/browser/pw-tools-core.activity.ts";
import { DEFAULT_UPLOAD_DIR } from "./vendor/openclaw/browser/paths.ts";
import { resolveStrictExistingPathsWithinRoot } from "./vendor/openclaw/browser/paths.ts";
import { DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS, DEFAULT_AI_SNAPSHOT_MAX_CHARS, } from "./vendor/openclaw/browser/constants.ts";
const DEFAULT_PROFILE_NAME = "host";
const DEFAULT_PROFILE_COLOR = "#FF4500";
const DEFAULT_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
function toStringOrEmpty(v) {
    if (typeof v === "string")
        return v.trim();
    if (typeof v === "number" || typeof v === "boolean")
        return String(v).trim();
    return "";
}
function toNumber(v) {
    if (typeof v === "number" && Number.isFinite(v))
        return v;
    if (typeof v === "string" && v.trim()) {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}
function toBoolean(v) {
    if (typeof v === "boolean")
        return v;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (["true", "1", "yes"].includes(s))
            return true;
        if (["false", "0", "no"].includes(s))
            return false;
    }
    if (typeof v === "number") {
        if (v === 1)
            return true;
        if (v === 0)
            return false;
    }
    return undefined;
}
async function resolveTargetIdAfterNavigate(opts) {
    let currentTargetId = opts.oldTargetId;
    try {
        const refreshed = await opts.listTabs();
        if (!refreshed.some((t) => t.targetId === opts.oldTargetId)) {
            const byUrl = refreshed.filter((t) => t.url === opts.navigatedUrl);
            const replaced = byUrl.find((t) => t.targetId !== opts.oldTargetId) ?? byUrl[0];
            if (replaced) {
                currentTargetId = replaced.targetId;
            }
            else {
                await new Promise((r) => setTimeout(r, 800));
                const retried = await opts.listTabs();
                const match = retried.find((t) => t.url === opts.navigatedUrl && t.targetId !== opts.oldTargetId) ??
                    retried.find((t) => t.url === opts.navigatedUrl) ??
                    (retried.length === 1 ? retried[0] : null);
                if (match) {
                    currentTargetId = match.targetId;
                }
            }
        }
    }
    catch {
        // Best-effort
    }
    return currentTargetId;
}
async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}
async function resolveUploadPaths(paths) {
    await ensureDir(DEFAULT_UPLOAD_DIR);
    const result = await resolveStrictExistingPathsWithinRoot({
        rootDir: DEFAULT_UPLOAD_DIR,
        requestedPaths: paths,
        scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
    });
    if (!result.ok) {
        throw new Error(result.error);
    }
    return result.paths;
}
function isActKind(v) {
    return (v === "click" ||
        v === "type" ||
        v === "press" ||
        v === "hover" ||
        v === "drag" ||
        v === "select" ||
        v === "fill" ||
        v === "resize" ||
        v === "wait" ||
        v === "evaluate" ||
        v === "close");
}
export class BrowserCloudController {
    sessions;
    lastTargetId = null;
    constructor(opts) {
        this.sessions = new BrowserUseCloudSessionManager({
            apiKey: opts.apiKey,
            profileId: opts.profileId,
            timeoutMin: opts.timeoutMin,
            idleStopMs: opts.idleStopMs,
        });
    }
    getSessionStatus() {
        return this.sessions.status();
    }
    async start() {
        await this.sessions.ensure();
        return { ok: true, profile: DEFAULT_PROFILE_NAME };
    }
    async stop() {
        const stopped = await this.sessions.stop({ reason: "explicit-stop" }).catch(() => false);
        this.lastTargetId = null;
        return { ok: true, stopped, profile: DEFAULT_PROFILE_NAME };
    }
    async status() {
        const s = this.sessions.status();
        const diag = await this.sessions.diagnose().catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
        return {
            enabled: true,
            profile: DEFAULT_PROFILE_NAME,
            running: s.running,
            cdpReady: s.running,
            cdpHttp: s.running,
            pid: null,
            cdpPort: 0,
            // Report base CDP URL for visibility; tool internals use the websocket URL.
            cdpUrl: s.cdpBaseUrl,
            // Best-effort last resolved websocket URL (may rotate)
            cdpWsUrl: s.cdpWsUrl,
            chosenBrowser: "browser-use-cloud",
            detectedBrowser: null,
            detectedExecutablePath: null,
            detectError: null,
            userDataDir: null,
            color: DEFAULT_PROFILE_COLOR,
            headless: true,
            noSandbox: null,
            executablePath: null,
            attachOnly: true,
            sessionId: s.sessionId,
            liveUrl: s.liveUrl,
            startedAt: s.startedAt,
            lastUsedAt: s.lastUsedAt,
            // Diagnostics: probes BU API + CDP base URL. Useful when CDP endpoint flaps.
            diag,
        };
    }
    async profiles() {
        const s = this.sessions.status();
        let tabCount = 0;
        if (s.running && s.cdpUrl) {
            try {
                const tabs = await listPagesViaPlaywright({ cdpUrl: s.cdpUrl });
                tabCount = tabs.length;
            }
            catch {
                tabCount = 0;
            }
        }
        return {
            profiles: [
                {
                    name: DEFAULT_PROFILE_NAME,
                    cdpPort: 0,
                    cdpUrl: s.cdpUrl ?? "",
                    color: DEFAULT_PROFILE_COLOR,
                    running: s.running,
                    tabCount,
                    isDefault: true,
                    isRemote: true,
                },
            ],
        };
    }
    async listTabsInternal(cdpUrl) {
        const tabs = await listPagesViaPlaywright({ cdpUrl });
        return tabs.map((t) => ({
            targetId: t.targetId,
            title: t.title,
            url: t.url,
            type: t.type,
        }));
    }
    async tabs(opts) {
        // Avoid relying on status().running (it is local knowledge). If we have a session object
        // with a cdpUrl, we consider it running enough to attempt listing.
        const cdpUrl = this.sessions.session?.cdpUrl ?? null;
        if (!cdpUrl) {
            return { running: false, tabs: [] };
        }
        const allTabs = await this.listTabsInternal(cdpUrl).catch(() => []);
        // Also surface the authoritative Target domain ids so the agent can pick a focusable id.
        let validTargets = [];
        try {
            const { browser } = await connectBrowser(cdpUrl);
            const session = await browser.newBrowserCDPSession();
            try {
                const got = (await session.send("Target.getTargets"));
                validTargets = Array.isArray(got?.targetInfos)
                    ? got.targetInfos.map((t) => String(t?.targetId ?? "").trim()).filter(Boolean)
                    : [];
            }
            finally {
                await session.detach().catch(() => { });
            }
        }
        catch {
            // ignore
        }
        const limit = typeof opts?.limit === "number" ? opts?.limit : Number(opts?.limit);
        const limited = Number.isFinite(limit) && limit > 0 ? allTabs.slice(0, Math.floor(limit)) : allTabs;
        const maxChars = typeof opts?.maxChars === "number" ? opts?.maxChars : Number(opts?.maxChars);
        const vt = validTargets.length ? ` validTargets=${validTargets.join(",")}` : "";
        const summaryRaw = `tabs=${limited.length}` + vt + " " + limited.map((t) => `${t.targetId}:${t.url}`).join(" | ");
        const summary = Number.isFinite(maxChars) && maxChars > 0 ? summaryRaw.slice(0, Math.floor(maxChars)) : summaryRaw;
        return {
            running: true,
            tabs: limited,
            validTargets,
            summary,
        };
    }
    pickPreferredTab(tabs) {
        // Prefer a real URL tab over about:blank placeholders.
        return (tabs.find((t) => t.url && t.url !== "about:blank") ??
            tabs.find((t) => t.url && !t.url.startsWith("about:")) ??
            tabs.at(0));
    }
    async ensureTabTargetId(opts) {
        const requested = toStringOrEmpty(opts.targetId);
        const listWithRetry = async () => {
            try {
                return await this.listTabsInternal(opts.cdpUrl);
            }
            catch {
                // Best-effort retry after a short delay (CDP target lists can race after file uploads).
                await new Promise((r) => setTimeout(r, 250));
                return await this.listTabsInternal(opts.cdpUrl);
            }
        };
        let tabs = await listWithRetry();
        // If caller requested a targetId, try hard to honor it, but fall back safely rather than crashing.
        if (requested) {
            let found = tabs.find((t) => t.targetId === requested);
            if (!found) {
                // Retry once more; Playwright can briefly report stale targets.
                await new Promise((r) => setTimeout(r, 400));
                tabs = await listWithRetry();
                found = tabs.find((t) => t.targetId === requested);
            }
            if (found) {
                // eslint-disable-next-line no-console
                console.log("[browser-cloud] ensureTabTargetId requested-hit", { requested, resolved: found.targetId, tabs: tabs.map(t => ({ targetId: t.targetId, url: t.url, title: t.title })) });
                this.lastTargetId = found.targetId;
                return found.targetId;
            }
            // Fallback: if requested tab vanished, pick a preferred remaining tab instead of throwing.
            const fallback = (this.lastTargetId ? tabs.find((t) => t.targetId === this.lastTargetId) : undefined) ??
                this.pickPreferredTab(tabs);
            if (fallback) {
                // eslint-disable-next-line no-console
                console.log("[browser-cloud] ensureTabTargetId requested-fallback", { requested, lastTargetId: this.lastTargetId, resolved: fallback.targetId, tabs: tabs.map(t => ({ targetId: t.targetId, url: t.url, title: t.title })) });
                this.lastTargetId = fallback.targetId;
                return fallback.targetId;
            }
            // As a last resort, create a new blank tab.
            const created = await createPageViaPlaywright({ cdpUrl: opts.cdpUrl, url: "about:blank" });
            this.lastTargetId = created.targetId;
            return created.targetId;
        }
        // No requested target: prefer sticky lastTargetId, else a reasonable first tab.
        if (this.lastTargetId) {
            const found = tabs.find((t) => t.targetId === this.lastTargetId);
            if (found) {
                // eslint-disable-next-line no-console
                console.log("[browser-cloud] ensureTabTargetId sticky-hit", { lastTargetId: this.lastTargetId, resolved: found.targetId, tabs: tabs.map(t => ({ targetId: t.targetId, url: t.url, title: t.title })) });
                return found.targetId;
            }
        }
        const preferred = this.pickPreferredTab(tabs);
        if (preferred) {
            // eslint-disable-next-line no-console
            console.log("[browser-cloud] ensureTabTargetId preferred", { resolved: preferred.targetId, tabs: tabs.map(t => ({ targetId: t.targetId, url: t.url, title: t.title })) });
            this.lastTargetId = preferred.targetId;
            return preferred.targetId;
        }
        const created = await createPageViaPlaywright({ cdpUrl: opts.cdpUrl, url: "about:blank" });
        this.lastTargetId = created.targetId;
        return created.targetId;
    }
    async open(urlRaw) {
        const url = toStringOrEmpty(urlRaw);
        if (!url) {
            throw new Error("url is required");
        }
        const { session, cdpUrl } = await this.sessions.ensure();
        this.sessions.touch();
        const tab = await createPageViaPlaywright({ cdpUrl, url });
        this.lastTargetId = tab.targetId;
        // eslint-disable-next-line no-console
        console.error("[browser-cloud] controller.open result", {
            sessionId: this.sessions.status().sessionId,
            cdpUrl,
            url,
            targetId: tab.targetId,
            tabUrl: tab.url,
            title: tab.title,
        });
        return {
            targetId: tab.targetId,
            title: tab.title,
            url: tab.url,
            type: tab.type,
            summary: `opened tab targetId=${tab.targetId} url=${tab.url}`,
        };
    }
    async focus(targetIdRaw) {
        const targetId = toStringOrEmpty(targetIdRaw);
        if (!targetId)
            throw new Error("targetId is required");
        const { cdpUrl } = await this.sessions.ensure();
        this.sessions.touch();
        // eslint-disable-next-line no-console
        console.error("[browser-cloud] controller.focus", {
            sessionId: this.sessions.status().sessionId,
            cdpUrl,
            targetId,
        });
        // No heuristics: focus exactly the requested targetId.
        // However, Target.getTargets can be briefly inconsistent right after opening tabs; do one short retry.
        try {
            await focusPageByTargetIdViaPlaywright({ cdpUrl, targetId });
            this.lastTargetId = targetId;
            return { ok: true, targetId };
        }
        catch (e1) {
            const valid1 = await this.getValidTargets(cdpUrl);
            if (!valid1.includes(targetId)) {
                await new Promise((r) => setTimeout(r, 400));
                const valid2 = await this.getValidTargets(cdpUrl);
                if (valid2.includes(targetId)) {
                    await focusPageByTargetIdViaPlaywright({ cdpUrl, targetId });
                    this.lastTargetId = targetId;
                    return { ok: true, targetId };
                }
            }
            const e = e1;
            // Provide actionable context for agents.
            let targets = [];
            try {
                const { browser } = await connectBrowser(cdpUrl);
                const session = await browser.newBrowserCDPSession();
                try {
                    const got = (await session.send("Target.getTargets"));
                    targets = Array.isArray(got?.targetInfos)
                        ? got.targetInfos.map((t) => ({
                            targetId: String(t?.targetId ?? ""),
                            type: String(t?.type ?? ""),
                            url: String(t?.url ?? ""),
                            title: String(t?.title ?? ""),
                        }))
                        : [];
                }
                finally {
                    await session.detach().catch(() => { });
                }
            }
            catch {
                // ignore
            }
            let tabs = [];
            try {
                tabs = await this.listTabsInternal(cdpUrl);
            }
            catch {
                // ignore
            }
            const hint = {
                requestedTargetId: targetId,
                validTargetIds: targets.map((t) => t.targetId).filter(Boolean),
                targets,
                tabs,
            };
            throw new Error(`focus failed: targetId not present or not resolvable. requested=${targetId}. ` +
                `validTargets=${hint.validTargetIds.join(",")}. ` +
                `Try calling browser_cloud tabs and using one of the returned targetIds. Original error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async close(targetIdRaw) {
        const targetId = toStringOrEmpty(targetIdRaw);
        if (!targetId)
            throw new Error("targetId is required");
        const { cdpUrl } = await this.sessions.ensure();
        this.sessions.touch();
        // No heuristics: close exactly the requested targetId.
        // One short retry for transient Target list inconsistency.
        try {
            await closePageByTargetIdViaPlaywright({ cdpUrl, targetId });
        }
        catch (e1) {
            const valid1 = await this.getValidTargets(cdpUrl);
            if (!valid1.includes(targetId)) {
                await new Promise((r) => setTimeout(r, 400));
                const valid2 = await this.getValidTargets(cdpUrl);
                if (valid2.includes(targetId)) {
                    await closePageByTargetIdViaPlaywright({ cdpUrl, targetId });
                }
                else {
                    throw e1;
                }
            }
            else {
                throw e1;
            }
        }
        if (this.lastTargetId === targetId)
            this.lastTargetId = null;
        return { ok: true, targetId };
    }
    async navigate(opts) {
        const url = toStringOrEmpty(opts.url);
        if (!url)
            throw new Error("url is required");
        const { cdpUrl } = await this.sessions.ensure();
        this.sessions.touch();
        const targetId = await this.ensureTabTargetId({ cdpUrl, targetId: opts.targetId });
        // eslint-disable-next-line no-console
        console.log("[browser-cloud] snapshot target", { requestedTargetId: opts.targetId, resolvedTargetId: targetId, cdpUrl });
        const timeoutMs = toNumber(opts.timeoutMs);
        const result = await navigateViaPlaywright({
            cdpUrl,
            targetId,
            url,
            ...(timeoutMs ? { timeoutMs } : {}),
        });
        const currentTargetId = await resolveTargetIdAfterNavigate({
            oldTargetId: targetId,
            navigatedUrl: result.url,
            listTabs: async () => (await this.listTabsInternal(cdpUrl)).map((t) => ({ targetId: t.targetId, url: t.url })),
        });
        this.lastTargetId = currentTargetId;
        return { ok: true, targetId: currentTargetId, ...result };
    }
    async console(opts) {
        const { cdpUrl } = await this.sessions.ensure();
        this.sessions.touch();
        const targetId = await this.ensureTabTargetId({ cdpUrl, targetId: opts.targetId });
        const level = toStringOrEmpty(opts.level) || undefined;
        const messages = await getConsoleMessagesViaPlaywright({ cdpUrl, targetId, level });
        return { ok: true, messages, targetId };
    }
    async pdf(opts) {
        const { cdpUrl } = await this.sessions.ensure();
        this.sessions.touch();
        const targetId = await this.ensureTabTargetId({ cdpUrl, targetId: opts.targetId });
        const pdf = await pdfViaPlaywright({ cdpUrl, targetId });
        const saved = await saveMediaBuffer({
            buffer: pdf.buffer,
            contentType: "application/pdf",
            maxBytes: pdf.buffer.byteLength,
        });
        const page = await getPageForTargetId({ cdpUrl, targetId });
        ensurePageState(page);
        return { ok: true, path: path.resolve(saved.path), targetId, url: page.url() };
    }
    async takeScreenshotAndMaybeReduce(opts) {
        // First attempt: vendor impl (no jpeg quality control).
        const first = await takeScreenshotViaPlaywright({
            cdpUrl: opts.cdpUrl,
            targetId: opts.targetId,
            ref: opts.ref,
            element: opts.element,
            fullPage: opts.fullPage,
            type: opts.type,
        });
        if (first.buffer.byteLength <= DEFAULT_SCREENSHOT_MAX_BYTES) {
            return { buffer: first.buffer, contentType: `image/${opts.type}` };
        }
        // If too large, retry as JPEG at decreasing quality (best-effort).
        const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
        ensurePageState(page);
        const locator = opts.ref
            ? refLocator(page, opts.ref)
            : opts.element
                ? page.locator(opts.element).first()
                : null;
        const qualities = [80, 70, 60, 50, 40, 30, 25, 20];
        for (const quality of qualities) {
            const buffer = locator
                ? await locator.screenshot({ type: "jpeg", quality })
                : await page.screenshot({ type: "jpeg", quality, fullPage: Boolean(opts.fullPage) });
            if (buffer.byteLength <= DEFAULT_SCREENSHOT_MAX_BYTES) {
                return { buffer, contentType: "image/jpeg" };
            }
        }
        return { buffer: first.buffer, contentType: `image/${opts.type}` };
    }
    isCdpNotReady(e) {
        const msg = e instanceof Error ? e.message : String(e);
        return msg.includes("CDP endpoint not ready");
    }
    async getValidTargets(cdpUrl) {
        try {
            const { browser } = await connectBrowser(cdpUrl);
            const session = await browser.newBrowserCDPSession();
            try {
                const got = (await session.send("Target.getTargets"));
                return Array.isArray(got?.targetInfos)
                    ? got.targetInfos.map((t) => String(t?.targetId ?? "").trim()).filter(Boolean)
                    : [];
            }
            finally {
                await session.detach().catch(() => { });
            }
        }
        catch {
            return [];
        }
    }
    async withCdpRetry(label, fn) {
        try {
            return await fn();
        }
        catch (e) {
            if (!this.isCdpNotReady(e))
                throw e;
            // eslint-disable-next-line no-console
            console.error("[browser-cloud] retrying after CDP not ready", { label, err: e instanceof Error ? e.message : String(e) });
            await closePlaywrightBrowserConnection().catch(() => { });
            await new Promise((r) => setTimeout(r, 1500));
            return await fn();
        }
    }
    async screenshot(opts) {
        const { cdpUrl } = await this.sessions.ensure();
        this.sessions.touch();
        const targetId = await this.ensureTabTargetId({ cdpUrl, targetId: opts.targetId });
        const fullPage = toBoolean(opts.fullPage) ?? false;
        const ref = toStringOrEmpty(opts.ref) || undefined;
        const element = toStringOrEmpty(opts.element) || undefined;
        const requestedType = opts.type === "jpeg" ? "jpeg" : "png";
        if (fullPage && (ref || element)) {
            throw new Error("fullPage is not supported for element screenshots");
        }
        const snap = await this.takeScreenshotAndMaybeReduce({
            cdpUrl,
            targetId,
            ref,
            element,
            fullPage,
            type: requestedType,
        });
        const saved = await saveMediaBuffer({
            buffer: snap.buffer,
            contentType: snap.contentType,
            maxBytes: DEFAULT_SCREENSHOT_MAX_BYTES,
        });
        const page = await getPageForTargetId({ cdpUrl, targetId });
        ensurePageState(page);
        return { ok: true, path: path.resolve(saved.path), targetId, url: page.url() };
    }
    async snapshot(opts) {
        return await this.withCdpRetry("snapshot", async () => {
            const { cdpUrl } = await this.sessions.ensure();
            this.sessions.touch();
            const targetId = await this.ensureTabTargetId({ cdpUrl, targetId: opts.targetId });
            const mode = opts.mode === "efficient" ? "efficient" : undefined;
            const labels = toBoolean(opts.labels) ?? undefined;
            const explicitFormat = opts.snapshotFormat === "aria" ? "aria" : opts.snapshotFormat === "ai" ? "ai" : undefined;
            const format = explicitFormat ?? (mode ? "ai" : "ai");
            if ((labels || mode === "efficient") && format === "aria") {
                throw new Error("labels/mode=efficient require format=ai");
            }
            const page = await getPageForTargetId({ cdpUrl, targetId });
            ensurePageState(page);
            const currentUrl = page.url();
            if (format === "aria") {
                const limit = toNumber(opts.limit);
                const resolved = await snapshotAriaViaPlaywright({ cdpUrl, targetId, ...(limit ? { limit } : {}) });
                return { ok: true, format, targetId, url: currentUrl, ...resolved };
            }
            const interactiveRaw = toBoolean(opts.interactive);
            const compactRaw = toBoolean(opts.compact);
            const depthRaw = toNumber(opts.depth);
            const selector = toStringOrEmpty(opts.selector);
            const frameSelector = toStringOrEmpty(opts.frame);
            const selectorValue = selector.trim() || undefined;
            const frameSelectorValue = frameSelector.trim() || undefined;
            const refsModeRaw = toStringOrEmpty(opts.refs).trim();
            const refsMode = refsModeRaw === "aria" ? "aria" : refsModeRaw === "role" ? "role" : undefined;
            // Optional cap to prevent huge payloads.
            const maxRefs = toNumber(opts.maxRefs);
            const interactive = interactiveRaw;
            const compact = compactRaw ?? (mode === "efficient" ? true : undefined);
            const depth = depthRaw ?? (mode === "efficient" ? 6 : undefined);
            const wantsRoleSnapshot = labels === true ||
                mode === "efficient" ||
                interactive === true ||
                compact === true ||
                depth !== undefined ||
                Boolean(selectorValue) ||
                Boolean(frameSelectorValue);
            const roleSnapshotArgs = {
                cdpUrl,
                targetId,
                selector: selectorValue,
                frameSelector: frameSelectorValue,
                refsMode,
                options: {
                    interactive: interactive ?? undefined,
                    compact: compact ?? undefined,
                    maxDepth: depth ?? undefined,
                },
            };
            const hasMaxChars = Object.hasOwn(opts, "maxChars");
            let maxChars = toNumber(opts.maxChars);
            if (!maxChars || !Number.isFinite(maxChars)) {
                // Default cap to prevent transcript/prompt compaction. Caller can override.
                maxChars = 8000;
            }
            const resolvedMaxChars = format === "ai"
                ? hasMaxChars
                    ? maxChars
                    : mode === "efficient"
                        ? DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS
                        : DEFAULT_AI_SNAPSHOT_MAX_CHARS
                : undefined;
            const snap = wantsRoleSnapshot
                ? await snapshotRoleViaPlaywright(roleSnapshotArgs)
                : await snapshotAiViaPlaywright({
                    cdpUrl,
                    targetId,
                    ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
                }).catch(async (err) => {
                    if (String(err).toLowerCase().includes("_snapshotforai")) {
                        return await snapshotRoleViaPlaywright(roleSnapshotArgs);
                    }
                    throw err;
                });
            if (labels) {
                const refs = "refs" in snap ? snap.refs : {};
                const labeled = await screenshotWithLabelsViaPlaywright({ cdpUrl, targetId, refs, type: "png" });
                const saved = await saveMediaBuffer({
                    buffer: labeled.buffer,
                    contentType: "image/png",
                    maxBytes: DEFAULT_SCREENSHOT_MAX_BYTES,
                });
                return {
                    ok: true,
                    format,
                    targetId,
                    url: currentUrl,
                    labels: true,
                    labelsCount: labeled.labels,
                    labelsSkipped: labeled.skipped,
                    imagePath: path.resolve(saved.path),
                    imageType: "png",
                    ...snap,
                };
            }
            // Optionally cap refs to prevent huge payloads.
            if (Number.isFinite(maxRefs) && maxRefs > 0 && snap && typeof snap === "object" && snap.refs && typeof snap.refs === "object") {
                const entries = Object.entries(snap.refs);
                if (entries.length > maxRefs) {
                    snap.refs = Object.fromEntries(entries.slice(0, Math.floor(maxRefs)));
                    snap.refsTruncated = true;
                    snap.refsTotal = entries.length;
                }
            }
            return { ok: true, format, targetId, url: currentUrl, ...snap };
        });
    }
    async upload(opts) {
        const rawPaths = Array.isArray(opts.paths) ? opts.paths : [];
        const paths = rawPaths.map((p) => toStringOrEmpty(p)).filter(Boolean);
        if (!paths.length)
            throw new Error("paths are required");
        const { cdpUrl } = await this.sessions.ensure();
        this.sessions.touch();
        const targetId = await this.ensureTabTargetId({ cdpUrl, targetId: opts.targetId });
        const ref = toStringOrEmpty(opts.ref) || undefined;
        const inputRef = toStringOrEmpty(opts.inputRef) || undefined;
        const element = toStringOrEmpty(opts.element) || undefined;
        const timeoutMs = toNumber(opts.timeoutMs);
        const resolvedPaths = await resolveUploadPaths(paths);
        // Preferred path: set input files directly.
        if (inputRef || element) {
            if (ref) {
                throw new Error("ref cannot be combined with inputRef/element");
            }
            await setInputFilesViaPlaywright({
                cdpUrl,
                targetId,
                inputRef,
                element,
                paths: resolvedPaths,
            });
            return { ok: true };
        }
        // Best-effort: if the page has a file input, set files directly.
        // This avoids relying on the fragile `filechooser` event.
        try {
            await setInputFilesViaPlaywright({
                cdpUrl,
                targetId,
                element: "input[type=file]",
                paths: resolvedPaths,
            });
            return { ok: true };
        }
        catch {
            // fall through
        }
        // Fallback: if caller provided a ref, click it to open a file chooser, then wait.
        try {
            if (ref) {
                await clickViaPlaywright({ cdpUrl, targetId, ref });
            }
            await uploadFilesToPage({ cdpUrl, targetId, paths: resolvedPaths, timeoutMs });
            return { ok: true };
        }
        catch (e) {
            // Upload failures are typically recoverable (transient CDP endpoint issues, timing, etc.).
            // Do not mark as fatal; let the agent retry without tearing down the BU session.
            throw new Error(`upload failed (sessionId=${this.sessions.status().sessionId ?? "unknown"}): ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    async dialog(opts) {
        const accept = toBoolean(opts.accept);
        if (accept === undefined)
            throw new Error("accept is required");
        const promptText = toStringOrEmpty(opts.promptText) || undefined;
        const timeoutMs = toNumber(opts.timeoutMs);
        const { cdpUrl } = await this.sessions.ensure();
        this.sessions.touch();
        const targetId = await this.ensureTabTargetId({ cdpUrl, targetId: opts.targetId });
        const page = await getPageForTargetId({ cdpUrl, targetId });
        ensurePageState(page);
        // Dialogs should be handled promptly; waiting 120s makes the tool appear hung.
        // Default to a short timeout unless the caller explicitly asks otherwise.
        const timeout = Math.max(250, Math.min(10_000, timeoutMs ?? 2_000));
        try {
            const dialog = await page.waitForEvent("dialog", { timeout });
            if (accept) {
                await dialog.accept(promptText);
            }
            else {
                await dialog.dismiss();
            }
            return { ok: true, handled: true };
        }
        catch {
            return { ok: true, handled: false, reason: "no-dialog" };
        }
    }
    async act(args) {
        const request = args.request && typeof args.request === "object" && !Array.isArray(args.request)
            ? args.request
            : null;
        const kindRaw = toStringOrEmpty(request?.kind ?? args.kind);
        if (!isActKind(kindRaw)) {
            throw new Error("kind is required");
        }
        const kind = kindRaw;
        const { cdpUrl } = await this.sessions.ensure();
        this.sessions.touch();
        const targetId = await this.ensureTabTargetId({ cdpUrl, targetId: (request?.targetId ?? args.targetId) });
        // eslint-disable-next-line no-console
        console.log("[browser-cloud] act target", { kind, requestedTargetId: (request?.targetId ?? args.targetId), resolvedTargetId: targetId, cdpUrl });
        const page = await getPageForTargetId({ cdpUrl, targetId });
        ensurePageState(page);
        const url = page.url();
        const body = request ?? args;
        switch (kind) {
            case "click": {
                const ref = toStringOrEmpty(body.ref);
                if (!ref)
                    throw new Error("ref is required");
                const doubleClick = toBoolean(body.doubleClick) ?? false;
                const timeoutMs = toNumber(body.timeoutMs);
                const buttonRaw = toStringOrEmpty(body.button);
                const button = buttonRaw === "left" || buttonRaw === "right" || buttonRaw === "middle"
                    ? buttonRaw
                    : undefined;
                const modifiersRaw = Array.isArray(body.modifiers) ? body.modifiers : [];
                const modifiers = modifiersRaw
                    .map((m) => toStringOrEmpty(m))
                    .filter(Boolean)
                    .filter((m) => ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(m));
                await clickViaPlaywright({
                    cdpUrl,
                    targetId,
                    ref,
                    doubleClick,
                    ...(button ? { button } : {}),
                    ...(modifiers.length ? { modifiers } : {}),
                    ...(timeoutMs ? { timeoutMs } : {}),
                });
                return { ok: true, targetId, url };
            }
            case "type": {
                const ref = toStringOrEmpty(body.ref);
                if (!ref)
                    throw new Error("ref is required");
                if (typeof body.text !== "string")
                    throw new Error("text is required");
                const text = body.text;
                const submit = toBoolean(body.submit) ?? false;
                const slowly = toBoolean(body.slowly) ?? false;
                const timeoutMs = toNumber(body.timeoutMs);
                await typeViaPlaywright({ cdpUrl, targetId, ref, text, submit, slowly, ...(timeoutMs ? { timeoutMs } : {}) });
                return { ok: true, targetId };
            }
            case "press": {
                const key = toStringOrEmpty(body.key);
                if (!key)
                    throw new Error("key is required");
                const delayMs = toNumber(body.delayMs);
                await pressKeyViaPlaywright({ cdpUrl, targetId, key, ...(delayMs ? { delayMs } : {}) });
                return { ok: true, targetId };
            }
            case "hover": {
                const ref = toStringOrEmpty(body.ref);
                if (!ref)
                    throw new Error("ref is required");
                const timeoutMs = toNumber(body.timeoutMs);
                await hoverViaPlaywright({ cdpUrl, targetId, ref, ...(timeoutMs ? { timeoutMs } : {}) });
                return { ok: true, targetId };
            }
            case "drag": {
                const startRef = toStringOrEmpty(body.startRef);
                const endRef = toStringOrEmpty(body.endRef);
                if (!startRef || !endRef)
                    throw new Error("startRef and endRef are required");
                const timeoutMs = toNumber(body.timeoutMs);
                await dragViaPlaywright({ cdpUrl, targetId, startRef, endRef, ...(timeoutMs ? { timeoutMs } : {}) });
                return { ok: true, targetId };
            }
            case "select": {
                const ref = toStringOrEmpty(body.ref);
                const values = Array.isArray(body.values)
                    ? body.values.map((v) => toStringOrEmpty(v)).filter(Boolean)
                    : [];
                const value = toStringOrEmpty(body.value);
                const normalized = values.length ? values : value ? [value] : [];
                if (!ref || !normalized.length) {
                    throw new Error("select requires ref and values (string[]) or value (string)");
                }
                const timeoutMs = toNumber(body.timeoutMs);
                await selectOptionViaPlaywright({ cdpUrl, targetId, ref, values: normalized, ...(timeoutMs ? { timeoutMs } : {}) });
                return { ok: true, targetId };
            }
            case "fill": {
                const fields = Array.isArray(body.fields) ? body.fields : [];
                if (!fields.length)
                    throw new Error("fields are required");
                const normalized = fields
                    .map((f) => (f && typeof f === "object" && !Array.isArray(f) ? f : null))
                    .filter(Boolean)
                    .map((f) => ({
                    ref: toStringOrEmpty(f.ref),
                    type: toStringOrEmpty(f.type) || "text",
                    value: (typeof f.value === "string" || typeof f.value === "number" || typeof f.value === "boolean")
                        ? f.value
                        : undefined,
                }))
                    .filter((f) => Boolean(f.ref));
                if (!normalized.length)
                    throw new Error("fields are required");
                const timeoutMs = toNumber(body.timeoutMs);
                await fillFormViaPlaywright({ cdpUrl, targetId, fields: normalized, ...(timeoutMs ? { timeoutMs } : {}) });
                return { ok: true, targetId };
            }
            case "resize": {
                const width = toNumber(body.width);
                const height = toNumber(body.height);
                if (!width || !height)
                    throw new Error("width and height are required");
                await resizeViewportViaPlaywright({ cdpUrl, targetId, width, height });
                const refreshed = await getPageForTargetId({ cdpUrl, targetId });
                ensurePageState(refreshed);
                return { ok: true, targetId, url: refreshed.url() };
            }
            case "wait": {
                const timeMs = toNumber(body.timeMs);
                const text = toStringOrEmpty(body.text) || undefined;
                const textGone = toStringOrEmpty(body.textGone) || undefined;
                const selector = toStringOrEmpty(body.selector) || undefined;
                const url = toStringOrEmpty(body.url) || undefined;
                const loadStateRaw = toStringOrEmpty(body.loadState);
                const loadState = loadStateRaw === "load" || loadStateRaw === "domcontentloaded" || loadStateRaw === "networkidle"
                    ? loadStateRaw
                    : undefined;
                const fn = toStringOrEmpty(body.fn) || undefined;
                const timeoutMs = toNumber(body.timeoutMs) ?? undefined;
                if (timeMs === undefined && !text && !textGone && !selector && !url && !loadState && !fn) {
                    throw new Error("wait requires at least one of: timeMs, text, textGone, selector, url, loadState, fn");
                }
                await waitForViaPlaywright({
                    cdpUrl,
                    targetId,
                    timeMs,
                    text,
                    textGone,
                    selector,
                    url,
                    loadState,
                    fn,
                    timeoutMs,
                });
                return { ok: true, targetId };
            }
            case "evaluate": {
                const fn = toStringOrEmpty(body.fn);
                if (!fn)
                    throw new Error("fn is required");
                const ref = toStringOrEmpty(body.ref) || undefined;
                const timeoutMs = toNumber(body.timeoutMs);
                const result = await evaluateViaPlaywright({
                    cdpUrl,
                    targetId,
                    fn,
                    ...(ref ? { ref } : {}),
                    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                });
                const refreshed = await getPageForTargetId({ cdpUrl, targetId });
                ensurePageState(refreshed);
                return { ok: true, targetId, url: refreshed.url(), result };
            }
            case "close": {
                await closePageViaPlaywright({ cdpUrl, targetId });
                if (this.lastTargetId === targetId)
                    this.lastTargetId = null;
                return { ok: true, targetId };
            }
            default: {
                throw new Error("unsupported kind");
            }
        }
    }
}
//# sourceMappingURL=browser-cloud-controller.js.map