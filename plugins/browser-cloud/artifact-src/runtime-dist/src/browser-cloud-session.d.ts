import { type BuSession } from "./bu-api.ts";
export type BrowserCloudSessionStatus = {
    running: boolean;
    sessionId: string | null;
    /** The BU API base CDP URL (typically https://<id>.cdp0.browser-use.com). */
    cdpBaseUrl: string | null;
    /** The websocket endpoint Playwright should connect to (resolved from base URL). */
    cdpWsUrl: string | null;
    liveUrl: string | null;
    startedAt: string | null;
    lastUsedAt: string | null;
};
export declare class BrowserUseCloudSessionManager {
    private apiKey;
    private profileId;
    private timeoutMin;
    private idleStopMs;
    session: BuSession | null;
    private lastResolvedWsUrl;
    private startedAtMs;
    private lastUsedAtMs;
    private idleTimer;
    private inFlight;
    private creating;
    private stopping;
    constructor(opts: {
        apiKey: string;
        profileId: string;
        timeoutMin: number;
        idleStopMs: number;
    });
    status(): BrowserCloudSessionStatus;
    /**
     * Probe BU + CDP endpoints to understand whether the session is actually alive.
     * This does NOT create a session.
     */
    diagnose(): Promise<{
        ok: true;
        sessionId: string | null;
        bu?: {
            ok: true;
            session: BuSession;
        } | {
            ok: false;
            error: string;
        };
        cdp?: {
            ok: true;
            httpStatus: number;
            contentType: string | null;
            hasWebSocketDebuggerUrl: boolean;
            webSocketDebuggerUrl: string | null;
        } | {
            ok: false;
            error: string;
        };
    }>;
    touch(): void;
    beginAction(action: string): void;
    endAction(action: string): void;
    private resetIdleTimer;
    ensure(): Promise<{
        session: BuSession;
        cdpUrl: string;
    }>;
    stop(opts?: {
        reason?: string;
    }): Promise<boolean>;
}
