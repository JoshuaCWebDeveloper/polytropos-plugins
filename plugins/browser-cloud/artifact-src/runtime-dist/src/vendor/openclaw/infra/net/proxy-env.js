export function hasProxyEnvConfigured() {
    const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
    return keys.some((k) => {
        const v = process.env[k];
        return typeof v === "string" && v.trim() !== "";
    });
}
//# sourceMappingURL=proxy-env.js.map