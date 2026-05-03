import type { BrowserServerState } from "./server-context.ts";
export declare const originalFetch: typeof fetch;
export declare function makeState(profile: "remote" | "openclaw"): BrowserServerState & {
    profiles: Map<string, {
        lastTargetId?: string | null;
    }>;
};
export declare function makeUnexpectedFetchMock(): any;
export declare function createRemoteRouteHarness(fetchMock?: (url: unknown) => Promise<Response>): {
    state: BrowserServerState & {
        profiles: Map<string, {
            lastTargetId?: string | null;
        }>;
    };
    remote: import("./server-context.types.js").ProfileContext;
    fetchMock: any;
};
export declare function createSequentialPageLister<T>(responses: T[]): () => Promise<NonNullable<T>>;
type JsonListEntry = {
    id: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
    type: "page";
};
export declare function createJsonListFetchMock(entries: JsonListEntry[]): (url: unknown) => Promise<Response>;
export declare function makeManagedTabsWithNew(params?: {
    newFirst?: boolean;
}): JsonListEntry[];
export {};
