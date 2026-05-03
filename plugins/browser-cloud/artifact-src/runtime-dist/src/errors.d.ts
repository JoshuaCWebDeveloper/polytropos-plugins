export declare class BrowserCloudFatalError extends Error {
    cause?: unknown | undefined;
    code: "BROWSER_CLOUD_FATAL";
    constructor(message: string, cause?: unknown | undefined);
}
export declare function isBrowserCloudFatalError(err: unknown): err is BrowserCloudFatalError;
