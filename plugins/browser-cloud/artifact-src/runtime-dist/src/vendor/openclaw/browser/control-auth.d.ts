import type { OpenClawConfig } from "../config/config.ts";
export type BrowserControlAuth = {
    token?: string;
    password?: string;
};
export declare function resolveBrowserControlAuth(cfg: OpenClawConfig | undefined, env?: NodeJS.ProcessEnv): BrowserControlAuth;
export declare function ensureBrowserControlAuth(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    auth: BrowserControlAuth;
    generatedToken?: string;
}>;
