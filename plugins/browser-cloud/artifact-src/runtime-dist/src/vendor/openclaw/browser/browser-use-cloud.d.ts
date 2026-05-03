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
export declare function createBrowserUseCloudSession(opts: {
    cfg: GatewayBrowserUseCloudConfig;
    profileId: string;
    timeoutMin: number;
    fetchImpl?: typeof fetch;
}): Promise<BrowserUseCloudSession>;
export declare function stopBrowserUseCloudSession(opts: {
    cfg: GatewayBrowserUseCloudConfig;
    sessionId: string;
    fetchImpl?: typeof fetch;
}): Promise<BrowserUseCloudSession>;
