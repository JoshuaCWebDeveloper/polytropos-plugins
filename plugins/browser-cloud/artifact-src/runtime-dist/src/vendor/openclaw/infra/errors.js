export function extractErrorCode(err) {
    if (!err || typeof err !== "object")
        return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyErr = err;
    const code = anyErr.code;
    return typeof code === "string" ? code : undefined;
}
export function formatErrorMessage(err) {
    if (err instanceof Error) {
        return err.message || String(err);
    }
    return String(err ?? "");
}
//# sourceMappingURL=errors.js.map