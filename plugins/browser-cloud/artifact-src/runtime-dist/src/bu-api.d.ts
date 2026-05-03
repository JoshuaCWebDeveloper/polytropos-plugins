export type BuSession = {
    id: string;
    status?: string;
    liveUrl?: string | null;
    cdpUrl?: string | null;
    timeoutAt?: string;
    startedAt?: string;
    finishedAt?: string | null;
};
export declare function buCreateBrowserSession(opts: {
    apiKey: string;
    profileId: string;
    timeoutMin: number;
}): Promise<BuSession>;
export declare function buGetBrowserSession(opts: {
    apiKey: string;
    sessionId: string;
}): Promise<BuSession>;
export declare function buStopBrowserSession(opts: {
    apiKey: string;
    sessionId: string;
}): Promise<BuSession>;
