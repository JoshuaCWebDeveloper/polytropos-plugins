type TabInfo = {
    targetId: string;
    title: string;
    url: string;
    type: string;
};
export declare class BrowserCloudController {
    private sessions;
    private lastTargetId;
    constructor(opts: {
        apiKey: string;
        profileId: string;
        timeoutMin: number;
        idleStopMs: number;
    });
    getSessionStatus(): import("./browser-cloud-session.ts").BrowserCloudSessionStatus;
    start(): Promise<{
        ok: true;
        profile: string;
    }>;
    stop(): Promise<{
        ok: true;
        stopped: boolean;
        profile: string;
    }>;
    status(): Promise<Record<string, unknown>>;
    profiles(): Promise<{
        profiles: Array<{
            name: string;
            cdpPort: number;
            cdpUrl: string;
            color: string;
            running: boolean;
            tabCount: number;
            isDefault: boolean;
            isRemote: boolean;
        }>;
    }>;
    private listTabsInternal;
    tabs(opts?: {
        limit?: unknown;
        maxChars?: unknown;
    }): Promise<{
        running: boolean;
        tabs: TabInfo[];
        summary?: string;
        validTargets?: string[];
    }>;
    private pickPreferredTab;
    private ensureTabTargetId;
    open(urlRaw: unknown): Promise<TabInfo>;
    focus(targetIdRaw: unknown): Promise<{
        ok: true;
        targetId: string;
    }>;
    close(targetIdRaw: unknown): Promise<{
        ok: true;
        targetId: string;
    }>;
    navigate(opts: {
        targetId?: unknown;
        url?: unknown;
        timeoutMs?: unknown;
    }): Promise<{
        url: string;
        ok: boolean;
        targetId: string;
    }>;
    console(opts: {
        targetId?: unknown;
        level?: unknown;
    }): Promise<{
        ok: boolean;
        messages: import("./vendor/openclaw/browser/pw-session.ts").BrowserConsoleMessage[];
        targetId: string;
    }>;
    pdf(opts: {
        targetId?: unknown;
    }): Promise<{
        ok: boolean;
        path: string;
        targetId: string;
        url: any;
    }>;
    private takeScreenshotAndMaybeReduce;
    private isCdpNotReady;
    private getValidTargets;
    private withCdpRetry;
    screenshot(opts: {
        targetId?: unknown;
        fullPage?: unknown;
        ref?: unknown;
        element?: unknown;
        type?: unknown;
    }): Promise<{
        ok: boolean;
        path: string;
        targetId: string;
        url: any;
    }>;
    snapshot(opts: {
        targetId?: unknown;
        mode?: unknown;
        snapshotFormat?: unknown;
        limit?: unknown;
        maxChars?: unknown;
        interactive?: unknown;
        compact?: unknown;
        depth?: unknown;
        selector?: unknown;
        frame?: unknown;
        labels?: unknown;
        refs?: unknown;
        /** Maximum number of refs to include when refs are requested (prevents huge payloads). */
        maxRefs?: unknown;
    }): Promise<{
        nodes: import("./vendor/openclaw/browser/pw-aria-snapshot.js").AriaSnapshotNode[];
        ok: boolean;
        format: string;
        targetId: string;
        url: any;
    } | {
        snapshot: string;
        truncated?: boolean;
        refs: import("./vendor/openclaw/browser/pw-role-snapshot.js").RoleRefMap;
        ok: boolean;
        format: string;
        targetId: string;
        url: any;
        labels: boolean;
        labelsCount: number;
        labelsSkipped: number;
        imagePath: string;
        imageType: string;
    } | {
        snapshot: string;
        refs: Record<string, {
            role: string;
            name?: string;
            nth?: number;
        }>;
        stats: {
            lines: number;
            chars: number;
            refs: number;
            interactive: number;
        };
        ok: boolean;
        format: string;
        targetId: string;
        url: any;
        labels: boolean;
        labelsCount: number;
        labelsSkipped: number;
        imagePath: string;
        imageType: string;
    } | {
        snapshot: string;
        truncated?: boolean;
        refs: import("./vendor/openclaw/browser/pw-role-snapshot.js").RoleRefMap;
        ok: boolean;
        format: string;
        targetId: string;
        url: any;
    } | {
        snapshot: string;
        refs: Record<string, {
            role: string;
            name?: string;
            nth?: number;
        }>;
        stats: {
            lines: number;
            chars: number;
            refs: number;
            interactive: number;
        };
        ok: boolean;
        format: string;
        targetId: string;
        url: any;
    }>;
    upload(opts: {
        targetId?: unknown;
        paths?: unknown;
        ref?: unknown;
        inputRef?: unknown;
        element?: unknown;
        timeoutMs?: unknown;
    }): Promise<{
        ok: boolean;
    }>;
    dialog(opts: {
        targetId?: unknown;
        accept?: unknown;
        promptText?: unknown;
        timeoutMs?: unknown;
    }): Promise<{
        ok: boolean;
        handled: boolean;
        reason?: undefined;
    } | {
        ok: boolean;
        handled: boolean;
        reason: string;
    }>;
    act(args: Record<string, unknown>): Promise<{
        ok: boolean;
        targetId: string;
        url: any;
        result?: undefined;
    } | {
        ok: boolean;
        targetId: string;
        url?: undefined;
        result?: undefined;
    } | {
        ok: boolean;
        targetId: string;
        url: any;
        result: unknown;
    }>;
}
export {};
