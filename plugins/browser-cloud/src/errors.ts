export class BrowserCloudFatalError extends Error {
  code = "BROWSER_CLOUD_FATAL" as const;
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "BrowserCloudFatalError";
  }
}

export function isBrowserCloudFatalError(err: unknown): err is BrowserCloudFatalError {
  return Boolean(
    err &&
      typeof err === "object" &&
      (err as any).code === "BROWSER_CLOUD_FATAL" &&
      (err as any).name === "BrowserCloudFatalError",
  );
}
