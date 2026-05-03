import { type BrowserServerState } from "./server-context.ts";
export declare function getBrowserControlState(): BrowserServerState | null;
export declare function createBrowserControlContext(): import("./server-context.types.js").BrowserRouteContext;
export declare function startBrowserControlServiceFromConfig(): Promise<BrowserServerState | null>;
export declare function stopBrowserControlService(): Promise<void>;
