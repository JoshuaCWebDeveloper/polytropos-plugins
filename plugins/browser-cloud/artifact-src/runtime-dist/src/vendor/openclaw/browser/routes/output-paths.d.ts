import type { BrowserResponse } from "./types.ts";
export declare function ensureOutputRootDir(rootDir: string): Promise<void>;
export declare function resolveWritableOutputPathOrRespond(params: {
    res: BrowserResponse;
    rootDir: string;
    requestedPath: string;
    scopeLabel: string;
    defaultFileName?: string;
    ensureRootDir?: boolean;
}): Promise<string | null>;
