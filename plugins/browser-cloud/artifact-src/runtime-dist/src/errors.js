export class BrowserCloudFatalError extends Error {
    cause;
    code = "BROWSER_CLOUD_FATAL";
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = "BrowserCloudFatalError";
    }
}
export function isBrowserCloudFatalError(err) {
    return Boolean(err &&
        typeof err === "object" &&
        err.code === "BROWSER_CLOUD_FATAL" &&
        err.name === "BrowserCloudFatalError");
}
//# sourceMappingURL=errors.js.map