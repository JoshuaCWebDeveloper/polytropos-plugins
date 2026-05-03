import dns from "node:dns/promises";
import net from "node:net";
export class SsrFBlockedError extends Error {
    constructor(message) {
        super(message);
        this.name = "SsrFBlockedError";
    }
}
export function isPrivateNetworkAllowedByPolicy(policy) {
    // Default permissive policy for the plugin unless explicitly disabled.
    if (!policy)
        return true;
    if (policy.allowPrivate === undefined)
        return true;
    return Boolean(policy.allowPrivate);
}
function resolvePinnedHostname(hostname, policy) {
    const pinned = policy?.pinnedHostnames?.[hostname];
    return typeof pinned === "string" && pinned.trim() ? pinned.trim() : hostname;
}
function isPrivateIp(ip) {
    if (net.isIP(ip) === 4) {
        const [a, b] = ip.split(".").map((n) => Number.parseInt(n ?? "", 10));
        if (a === 10)
            return true;
        if (a === 127)
            return true;
        if (a === 192 && b === 168)
            return true;
        if (a === 172 && b >= 16 && b <= 31)
            return true;
        return false;
    }
    if (net.isIP(ip) === 6) {
        const lower = ip.toLowerCase();
        if (lower === "::1")
            return true;
        if (lower.startsWith("fc") || lower.startsWith("fd"))
            return true; // unique local
        if (lower.startsWith("fe80:"))
            return true; // link-local
        return false;
    }
    return false;
}
export async function defaultLookup(hostname) {
    const res = await dns.lookup(hostname, { all: true });
    return res.map((r) => r.address);
}
export async function resolvePinnedHostnameWithPolicy(hostname, opts) {
    const resolvedHost = resolvePinnedHostname(hostname, opts?.policy);
    if (isPrivateNetworkAllowedByPolicy(opts?.policy)) {
        return resolvedHost;
    }
    const lookup = opts?.lookupFn ?? defaultLookup;
    const ips = await lookup(resolvedHost);
    if (ips.some((ip) => isPrivateIp(ip))) {
        throw new SsrFBlockedError(`SSRF blocked by policy for host: ${resolvedHost}`);
    }
    return resolvedHost;
}
//# sourceMappingURL=ssrf.js.map