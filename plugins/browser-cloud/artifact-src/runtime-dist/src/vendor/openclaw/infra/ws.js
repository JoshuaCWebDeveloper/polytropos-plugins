export function rawDataToString(data) {
    if (typeof data === "string") {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString("utf-8");
    }
    // ws RawData is usually Buffer | ArrayBuffer | Buffer[] | string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyData = data;
    if (Array.isArray(anyData)) {
        return Buffer.concat(anyData).toString("utf-8");
    }
    if (Buffer.isBuffer(anyData)) {
        return anyData.toString("utf-8");
    }
    return String(data ?? "");
}
//# sourceMappingURL=ws.js.map