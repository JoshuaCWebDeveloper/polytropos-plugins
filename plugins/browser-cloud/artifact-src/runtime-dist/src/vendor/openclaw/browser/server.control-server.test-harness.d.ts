import type { MockFn } from "../test-utils/vitest-mock-fn.ts";
export { getFreePort } from "./test-port.ts";
type HarnessState = {
    testPort: number;
    cdpBaseUrl: string;
    reachable: boolean;
    cfgAttachOnly: boolean;
    cfgEvaluateEnabled: boolean;
    createTargetId: string | null;
    prevGatewayPort: string | undefined;
    prevGatewayToken: string | undefined;
    prevGatewayPassword: string | undefined;
};
export declare function getBrowserControlServerTestState(): HarnessState;
export declare function getBrowserControlServerBaseUrl(): string;
export declare function restoreGatewayPortEnv(prevGatewayPort: string | undefined): void;
export declare function setBrowserControlServerCreateTargetId(targetId: string | null): void;
export declare function setBrowserControlServerAttachOnly(attachOnly: boolean): void;
export declare function setBrowserControlServerEvaluateEnabled(enabled: boolean): void;
export declare function setBrowserControlServerReachable(reachable: boolean): void;
export declare function getCdpMocks(): {
    createTargetViaCdp: MockFn;
    snapshotAria: MockFn;
};
export declare function getPwMocks(): Record<string, MockFn>;
export declare function getLaunchCalls(): any;
export declare const startBrowserControlServerFromConfig: typeof import("./server.js").startBrowserControlServerFromConfig;
export declare const stopBrowserControlServer: typeof import("./server.js").stopBrowserControlServer;
export declare function makeResponse(body: unknown, init?: {
    ok?: boolean;
    status?: number;
    text?: string;
}): Response;
export declare function resetBrowserControlServerTestContext(): Promise<void>;
export declare function restoreGatewayAuthEnv(prevGatewayToken: string | undefined, prevGatewayPassword: string | undefined): void;
export declare function cleanupBrowserControlServerTestContext(): Promise<void>;
export declare function installBrowserControlServerHooks(): void;
