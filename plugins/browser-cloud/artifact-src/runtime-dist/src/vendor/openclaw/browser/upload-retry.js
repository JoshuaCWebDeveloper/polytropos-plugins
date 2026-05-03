const MAX_UPLOAD_RETRIES = 3;
const UPLOAD_BACKOFF_MS = 1000;
async function uploadFilesToPage(opts) {
    const { browser } = await connectBrowser(opts.cdpUrl);
    const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
    if (!page) {
        throw new Error("tab not found after upload");
    }
    // Handle "target closed" by forcing a reconnect and retry
    for (let attempt = 0; attempt < MAX_UPLOAD_RETRIES; attempt++) {
        try {
            ensurePageState(page);
            const timeout = Math.max(500, Math.min(120_000, opts.timeoutMs ?? 120_000));
            const waiter = page.waitForEvent("filechooser", { timeout }).then(async (chooser) => {
                await chooser.setFiles(opts.paths);
                try {
                    const input = typeof chooser.element === "function" ? await Promise.resolve(chooser.element()) : null;
                    if (input) {
                        await input.evaluate((el) => {
                            el.dispatchEvent(new Event("input", { bubbles: true }));
                            el.dispatchEvent(new Event("change", { bubbles: true }));
                        });
                    }
                }
                catch {
                    // best-effort
                }
            });
            // If ref is needed, caller should have clicked it already
            await waiter;
            return; // Success!
        }
        catch (err) {
            const isTargetClosed = err instanceof Error && (err.message.includes("Target page, context or browser has been closed") ||
                err.message.includes("has been closed") ||
                err.code === "ECONNRESET" ||
                err.code === "ENOTFOUND");
            if (isTargetClosed && attempt < MAX_UPLOAD_RETRIES - 1) {
                // Force disconnect and reconnect
                await forceDisconnectPlaywrightForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
                // Reconnect with fresh browser instance
                const { browser: newBrowser } = await connectBrowser(opts.cdpUrl);
                const newPage = await findPageByTargetId(newBrowser, opts.targetId, opts.cdpUrl);
                if (!newPage) {
                    throw new Error(`tab not found after reconnect (attempt ${attempt + 1})`);
                }
                // Replace the stale page reference with the fresh one
                page.context()._pages = page.context()._pages.map(p => p === page ? newPage : p);
                page = newPage;
                // Brief backoff before retry
                await new Promise(r => setTimeout(r, UPLOAD_BACKOFF_MS * (attempt + 1)));
                continue;
            }
            // Not a target closed error or out of retries - rethrow
            throw err;
        }
    }
    throw new Error(`Upload failed after ${MAX_UPLOAD_RETRIES} attempts`);
}
export { uploadFilesToPage };
//# sourceMappingURL=upload-retry.js.map