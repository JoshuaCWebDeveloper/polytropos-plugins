import { type BrowserServerState } from "./server-context.ts";
export declare function startBrowserControlServerFromConfig(): Promise<BrowserServerState | null>;
export declare function stopBrowserControlServer(): Promise<void>;
